<?php
/* cron から毎分動かす：時間が来たリマインドをプッシュ通知で送る
   例）/usr/bin/php8.3 /home/ユーザー名/ドメイン/public_html/memo-api/cron.php */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require __DIR__ . '/lib.php';
date_default_timezone_set('Asia/Tokyo');
try {
  $n = run_reminders();
  if ($n) echo date('Y-m-d H:i:s') . " sent {$n}\n";
} catch (Exception $e) {
  fwrite(STDERR, $e->getMessage() . "\n");
  exit(1);
}
