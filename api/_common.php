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
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: ' . $cache);
  header('X-Content-Type-Options: nosniff');
  echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

/* 簡易レート制限（ファイルで数える）。本当の歯止めはOpenAIの前払い残高。 */
function kemuri_rate_limited(string $name, int $max, int $windowSec): bool {
  $dir = kemuri_private_dir() . '/tmp';
  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  $f = $dir . '/rate-' . preg_replace('/[^a-z0-9_-]/i', '', $name) . '.json';
  $fp = @fopen($f, 'c+');
  if (!$fp) return false;
  flock($fp, LOCK_EX);
  $hits = json_decode(stream_get_contents($fp) ?: '[]', true);
  if (!is_array($hits)) $hits = [];
  $now = time();
  $hits = array_values(array_filter($hits, fn($t) => is_int($t) && $now - $t < $windowSec));
  $limited = count($hits) >= $max;
  if (!$limited) $hits[] = $now;
  ftruncate($fp, 0); rewind($fp); fwrite($fp, json_encode($hits));
  flock($fp, LOCK_UN); fclose($fp);
  return $limited;
}
