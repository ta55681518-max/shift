<?php
/* ============================================================
   KEMURI 音声メモ — Xserver 用 API
   ?a=setup        初回設定（合言葉を決める・通知用の鍵を作る）※1回だけ
   ?a=info         通知用の公開鍵など（合言葉不要）
   ?a=sync         メモの同期（合言葉が必要）
   ?a=subscribe    この端末で通知を受け取る
   ?a=unsubscribe  通知をやめる
   ?a=testpush     この端末にテスト通知
   ?a=cron&token=… cron を URL で動かすとき用（ふだんは cron.php を使う）
   ============================================================ */
require __DIR__ . '/lib.php';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('X-Content-Type-Options: nosniff');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') exit;

$a = $_GET['a'] ?? '';

function out($arr, $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($arr, JSON_UNESCAPED_UNICODE);
  exit;
}
function body() {
  static $b = null;
  if ($b === null) { $b = json_decode((string) file_get_contents('php://input'), true); if (!is_array($b)) $b = []; }
  return $b;
}
function need_auth($cfg) {
  $p = (string) (body()['pass'] ?? '');
  if ($p === '' || !password_verify($p, $cfg['passHash'])) { sleep(1); out(['ok' => false, 'error' => '合言葉がちがいます'], 403); }
}
function clean_str($s, $max) { return mb_substr((string) $s, 0, $max); }
function clean_memo($m) {
  if (!is_array($m) || empty($m['id']) || !is_string($m['id']) || strlen($m['id']) > 40) return null;
  $o = ['id' => $m['id'], 'rev' => (int) ($m['rev'] ?? 0)];
  if (!empty($m['deleted'])) { $o['deleted'] = true; return $o; }
  $o += [
    'cat' => clean_str($m['cat'] ?? '', 40),
    'text' => clean_str($m['text'] ?? '', 5000),
    'created' => (int) ($m['created'] ?? 0),
    'updated' => (int) ($m['updated'] ?? 0),
    'remind' => !empty($m['remind']) ? (int) $m['remind'] : null,
    'repeat' => in_array($m['repeat'] ?? '', ['daily', 'weekdays', 'weekly', 'monthly'], true) ? $m['repeat'] : '',
    'notified' => !empty($m['notified']),
    'done' => !empty($m['done']),
    'pin' => !empty($m['pin']),
    'voice' => !empty($m['voice']),
    'notify' => ($m['notify'] ?? 'all') === 'me' ? 'me' : 'all',
    'owner' => clean_str($m['owner'] ?? '', 40),
    'by' => clean_str($m['by'] ?? '', 20),
  ];
  if (!empty($m['doneAt'])) $o['doneAt'] = (int) $m['doneAt'];
  if (!empty($m['resume'])) $o['resume'] = (int) $m['resume'];
  return $o;
}

$cfg = load_config();

/* ---------------- 初回設定 ---------------- */
if ($a === 'setup') {
  header('Content-Type: text/html; charset=utf-8');
  $self = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? '') . dirname($_SERVER['SCRIPT_NAME'] ?? '/') . '/';
  $msg = '';
  if (!$cfg && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $p1 = (string) ($_POST['p1'] ?? ''); $p2 = (string) ($_POST['p2'] ?? '');
    if (mb_strlen($p1) < 8) $msg = '合言葉は8文字以上にしてください。';
    elseif ($p1 !== $p2) $msg = '確認用の合言葉が一致しません。';
    elseif (!function_exists('openssl_pkey_derive') || !function_exists('curl_init')) $msg = 'PHPの openssl / curl が使えません。サーバーパネルでPHPを8.x にしてください。';
    else {
      try {
        $cfg = ['passHash' => password_hash($p1, PASSWORD_DEFAULT), 'vapid' => generate_vapid(),
                'cronToken' => bin2hex(random_bytes(16)), 'subject' => 'https://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . '/',
                'created' => date('c')];
        save_config($cfg);
        with_store(function (&$d, &$changed) { $changed = true; });
      } catch (Exception $e) { $cfg = null; $msg = 'エラー：' . $e->getMessage(); }
    }
  }
  $h = function ($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); };
  echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>音声メモ サーバー設定</title>';
  echo '<style>body{font-family:sans-serif;max-width:640px;margin:20px auto;padding:0 16px;line-height:1.7;background:#1a1210;color:#f5efe6}input{font-size:16px;padding:10px;width:100%;box-sizing:border-box;margin:4px 0 10px}button{font-size:16px;padding:12px 20px;background:#e8622a;color:#fff;border:none;border-radius:10px}code{background:#000;padding:8px;display:block;word-break:break-all;border-radius:6px;color:#ffcf9e}.e{color:#ff8a7a}</style>';
  echo '<h1>🎤 音声メモ サーバー設定</h1>';
  if (!$cfg) {
    if ($msg) echo '<p class="e">' . $h($msg) . '</p>';
    echo '<p>お店の<b>合言葉</b>を決めてください。スタッフのiPhoneでもこの合言葉を入れると、同じメモを見られます（8文字以上）。</p>';
    echo '<form method="post"><label>合言葉<input type="password" name="p1" autocomplete="new-password"></label><label>もう一度<input type="password" name="p2"></label><button>設定する</button></form>';
  } else {
    $writable = is_writable(MEMO_DATA_DIR);
    echo '<p>✅ 設定済みです。' . ($writable ? '' : '<span class="e">ただし data フォルダに書き込めません。パーミッションを 700 か 755 にしてください。</span>') . '</p>';
    echo '<h3>① アプリに入れるサーバーのURL</h3><code>' . $h($self) . '</code>';
    echo '<h3>② cron（1分ごと）に登録するコマンド</h3><p>サーバーパネル →「Cron設定」→ 分・時・日・月・曜日をすべて <b>*</b> にして、コマンドに：</p>';
    echo '<code>/usr/bin/php8.3 ' . $h(__DIR__ . '/cron.php') . ' &gt; /dev/null 2&gt;&amp;1</code>';
    echo '<p style="font-size:13px">php8.3 の部分は、サーバーパネルの「PHP Ver.切替」で選んでいるバージョンに合わせてください（例：php8.2）。うまくいかないときは代わりに：</p>';
    echo '<code>curl -s "' . $h($self . 'api.php?a=cron&token=' . $cfg['cronToken']) . '" &gt; /dev/null</code>';
    echo '<p style="font-size:13px">合言葉を変えたいときは、FTPで data/config.json を消してからこのページを開き直します（通知の登録はやり直しになります）。</p>';
  }
  exit;
}

if (!$cfg) out(['ok' => false, 'error' => 'サーバーが未設定です。' . 'api.php?a=setup を開いて設定してください'], 503);

/* ---------------- 公開情報 ---------------- */
if ($a === 'info') out(['ok' => true, 'vapid' => $cfg['vapid']['pub'], 'time' => now_ms()]);

/* ---------------- cron（URL版） ---------------- */
if ($a === 'cron') {
  if (!hash_equals($cfg['cronToken'], (string) ($_GET['token'] ?? ''))) out(['ok' => false], 403);
  out(['ok' => true, 'sent' => run_reminders()]);
}

need_auth($cfg);
$b = body();
$device = clean_str($b['device'] ?? '', 40);
$name = clean_str($b['name'] ?? '', 20);

/* ---------------- 同期 ---------------- */
if ($a === 'sync') {
  $res = with_store(function (&$d, &$changed) use ($b, $cfg, $device, $name) {
    $map = [];
    foreach ($d['memos'] as $m) $map[$m['id']] = $m;
    $accepted = 0;
    foreach ((array) ($b['memos'] ?? []) as $in) {
      $m = clean_memo($in);
      if (!$m) continue;
      $cur = $map[$m['id']] ?? null;
      if (!$cur || $m['rev'] >= (int) ($cur['rev'] ?? 0)) { $map[$m['id']] = $m; $accepted++; $changed = true; }
    }
    // 消したメモの印は一定期間で片づける
    $limit = now_ms() - MEMO_TOMBSTONE_DAYS * 86400000;
    foreach ($map as $id => $m) if (!empty($m['deleted']) && $m['rev'] < $limit) { unset($map[$id]); $changed = true; }
    $d['memos'] = array_values($map);
    if (isset($b['cats']) && is_array($b['cats']) && (int) ($b['catsRev'] ?? 0) > (int) $d['catsRev']) {
      $cats = [];
      foreach (array_slice($b['cats'], 0, 50) as $c) {
        if (!is_array($c) || empty($c['id'])) continue;
        $cats[] = ['id' => clean_str($c['id'], 40), 'name' => clean_str($c['name'] ?? '', 20), 'emoji' => clean_str($c['emoji'] ?? '', 4), 'color' => clean_str($c['color'] ?? '#7a6a5e', 9)];
      }
      if ($cats) { $d['cats'] = $cats; $d['catsRev'] = (int) $b['catsRev']; $changed = true; }
    }
    // 端末の最終アクセス（設定画面で «共有している人» を出す）
    foreach ($d['subs'] as &$s) if (($s['device'] ?? '') === $device) { $s['seen'] = now_ms(); if ($name) $s['name'] = $name; }
    unset($s);
    // cron が止まっていても、誰かが開けば時間の来た通知を送る
    run_reminders_locked($d, $changed, $cfg);
    $people = [];
    foreach ($d['subs'] as $s) $people[] = ['name' => $s['name'] ?? '', 'me' => ($s['device'] ?? '') === $device];
    return ['ok' => true, 'memos' => $d['memos'], 'cats' => $d['cats'], 'catsRev' => $d['catsRev'], 'accepted' => $accepted, 'people' => $people, 'time' => now_ms()];
  });
  out($res);
}

/* ---------------- 通知の登録 ---------------- */
if ($a === 'subscribe') {
  $s = $b['sub'] ?? null;
  if (!is_array($s) || empty($s['endpoint']) || empty($s['keys']['p256dh']) || empty($s['keys']['auth'])) out(['ok' => false, 'error' => '購読情報がありません'], 400);
  if (!preg_match('#^https://#', $s['endpoint'])) out(['ok' => false, 'error' => '不正なendpoint'], 400);
  with_store(function (&$d, &$changed) use ($s, $device, $name) {
    $d['subs'] = array_values(array_filter($d['subs'], function ($x) use ($s, $device) { return $x['endpoint'] !== $s['endpoint'] && ($x['device'] ?? '') !== $device; }));
    $d['subs'][] = ['endpoint' => $s['endpoint'], 'keys' => ['p256dh' => $s['keys']['p256dh'], 'auth' => $s['keys']['auth']], 'device' => $device, 'name' => $name, 'created' => now_ms(), 'seen' => now_ms()];
    $changed = true;
  });
  out(['ok' => true]);
}
if ($a === 'unsubscribe') {
  with_store(function (&$d, &$changed) use ($device) {
    $n = count($d['subs']);
    $d['subs'] = array_values(array_filter($d['subs'], function ($x) use ($device) { return ($x['device'] ?? '') !== $device; }));
    $changed = $n !== count($d['subs']);
  });
  out(['ok' => true]);
}
if ($a === 'testpush') {
  $subs = with_store(function (&$d, &$changed) { return $d['subs']; });
  $codes = [];
  foreach ($subs as $s) {
    if (($s['device'] ?? '') !== $device) continue;
    try { $codes[] = webpush_send($s, ['title' => '🔔 テスト通知', 'body' => 'Xserverからの通知が届きました', 'id' => ''], $cfg); }
    catch (Exception $e) { $codes[] = $e->getMessage(); }
  }
  if (!$codes) out(['ok' => false, 'error' => 'この端末は通知の登録がまだです']);
  out(['ok' => true, 'codes' => $codes]);
}

out(['ok' => false, 'error' => 'unknown action'], 400);
