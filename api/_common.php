<?php
/* ============================================================
   串焼KEMURI屋 サーバー側の共通部品（Xserver版）
   ・合言葉やOpenAIのキーは、公開フォルダの外の
     kemuriya-shuri.com/kemuri-private/config.php に置く。
     → ブラウザからもGitHubからも見えない。
   ・Netlify Functions（netlify/functions/*.js）と同じ動きにしてある。
   ============================================================ */
declare(strict_types=1);

/* 小数を「8.6」のように短く出す（サーバーの設定によっては 8.5999999… と長くなるため） */
ini_set('serialize_precision', '-1');

/* …/kemuriya-shuri.com/public_html/<サブドメイン>/api → …/kemuriya-shuri.com/kemuri-private */
function kemuri_private_dir(): string {
  return dirname(__DIR__, 3) . '/kemuri-private';
}

function kemuri_config(): array {
  $f = kemuri_private_dir() . '/config.php';
  if (!is_file($f)) return [];
  $c = include $f;
  return is_array($c) ? $c : [];
}

function kemuri_json(int $status, array $obj, string $cache = 'no-store'): void {
  $body = json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  /* 返事を作れなかったとき：成功の番号のまま空を返さない（指摘A-3） */
  if (!is_string($body) || $body === '') { $status = 500; $cache = 'no-store'; $body = '{"ok":false,"why":"返事を作れませんでした"}'; }
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: ' . $cache);
  header('X-Content-Type-Options: nosniff');
  echo $body;
  exit;
}

/* 簡易レート制限（ファイルで数える）。本当の歯止めはOpenAIの前払い残高。
   記録のファイルを開けない・鍵を取れない・書けないときは «制限中» として扱う（true を返す）。
   数えられないまま外へ取りにいかないため（指摘A-4）。 */
function kemuri_rate_limited(string $name, int $max, int $windowSec): bool {
  $dir = kemuri_private_dir() . '/tmp';
  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  if (!is_dir($dir)) return true;
  $f = $dir . '/rate-' . preg_replace('/[^a-z0-9_-]/i', '', $name) . '.json';
  $fp = @fopen($f, 'c+');
  if (!$fp) return true;
  if (!flock($fp, LOCK_EX)) { fclose($fp); return true; }
  $raw = stream_get_contents($fp);
  $hits = json_decode(is_string($raw) && $raw !== '' ? $raw : '[]', true);
  if (!is_array($hits)) $hits = [];
  $now = time();
  $hits = array_values(array_filter($hits, fn($t) => is_int($t) && $now - $t < $windowSec));
  $limited = count($hits) >= $max;
  if (!$limited) $hits[] = $now;
  $json = json_encode($hits);
  $ok = is_string($json) && ftruncate($fp, 0) && rewind($fp) && fwrite($fp, $json) === strlen($json) && fflush($fp);
  flock($fp, LOCK_UN); fclose($fp);
  return $limited || !$ok;
}
