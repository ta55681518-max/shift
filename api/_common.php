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
   方針：«数えられないときは、外へ出さない»（true＝制限中 を返す）。
   ・鍵は別のファイル（rate-NAME.lock）で取る。記録（rate-NAME.json）は、別の名前で書いてから入れ替える
     → 書くのに失敗しても、元の記録は壊れない
   ・記録が «まだ無い» のと «あるのに読めない・形が壊れている» のを区別する。
     壊れているときは制限中として扱い、記録を «上限いっぱい» に作り直す（時間がたてば自然に元へ戻る） */
function kemuri_rate_limited(string $name, int $max, int $windowSec): bool {
  $dir = kemuri_private_dir() . '/tmp';
  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  if (!is_dir($dir)) return true;
  $base = $dir . '/rate-' . preg_replace('/[^a-z0-9_-]/i', '', $name);
  $lock = @fopen($base . '.lock', 'c');
  if (!$lock) return true;
  if (!flock($lock, LOCK_EX)) { fclose($lock); return true; }
  $limited = true;
  try {
    $f = $base . '.json';
    $now = time();
    $put = function (array $hits) use ($f): bool {
      $json = json_encode(array_values($hits));
      if (!is_string($json)) return false;
      $tmp = $f . '.' . bin2hex(random_bytes(4)) . '.tmp';
      if (@file_put_contents($tmp, $json) !== strlen($json)) { @unlink($tmp); return false; }
      if (!@rename($tmp, $f)) { @unlink($tmp); return false; }
      return true;
    };
    clearstatcache(true, $f);
    if (!file_exists($f)) {
      $hits = [];                                         // まだ記録が無い（最初の1回）
    } else {
      $raw = @file_get_contents($f);
      $hits = is_string($raw) ? json_decode($raw, true) : null;
      $ok = is_array($hits) && $hits === array_values($hits);
      if ($ok) foreach ($hits as $t) if (!is_int($t)) { $ok = false; break; }
      if (!$ok) { $put(array_fill(0, $max, $now)); return true; }   // 読めない・壊れている → 止める
    }
    $hits = array_values(array_filter($hits, fn($t) => $t <= $now && $now - $t < $windowSec));
    if (count($hits) >= $max) return true;
    $hits[] = $now;
    $limited = !$put($hits);                              // 書けなかったら、数えられていないので止める
    return $limited;
  } finally {
    flock($lock, LOCK_UN); fclose($lock);
  }
}
