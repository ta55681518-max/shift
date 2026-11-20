<?php
/* ============================================================
   KEMURI 音声メモ — Xserver 用サーバー（共通部分）
   ・メモの保管（data/memo.json）と、リマインドのプッシュ通知（Web Push）
   ・composer などのライブラリは使わず、PHP標準の openssl と curl だけで動く
   ・設定は data/config.json（初回に api.php?a=setup で自動作成）
   ============================================================ */

define('MEMO_DATA_DIR', __DIR__ . '/data');
define('MEMO_CONFIG', MEMO_DATA_DIR . '/config.json');
define('MEMO_STORE', MEMO_DATA_DIR . '/memo.json');
define('MEMO_TOMBSTONE_DAYS', 60);

function now_ms() { return (int) floor(microtime(true) * 1000); }

function b64u_enc($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
function b64u_dec($s) {
  $s = strtr((string) $s, '-_', '+/');
  $pad = strlen($s) % 4;
  if ($pad) $s .= str_repeat('=', 4 - $pad);
  return base64_decode($s, true);
}

/* ---------------- 設定 ---------------- */
function load_config() {
  if (!is_file(MEMO_CONFIG)) return null;
  $c = json_decode((string) file_get_contents(MEMO_CONFIG), true);
  return is_array($c) ? $c : null;
}
function save_config($c) {
  if (!is_dir(MEMO_DATA_DIR)) mkdir(MEMO_DATA_DIR, 0700, true);
  $tmp = MEMO_CONFIG . '.tmp';
  file_put_contents($tmp, json_encode($c, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
  @chmod($tmp, 0600);
  rename($tmp, MEMO_CONFIG);
}

/* ---------------- データ（ロックして読み書き） ---------------- */
function with_store($fn) {
  if (!is_dir(MEMO_DATA_DIR)) mkdir(MEMO_DATA_DIR, 0700, true);
  $fp = fopen(MEMO_STORE, 'c+');
  if (!$fp) throw new Exception('データファイルを開けません（data フォルダの書き込み権限を確認）');
  flock($fp, LOCK_EX);
  $raw = stream_get_contents($fp);
  $d = $raw ? json_decode($raw, true) : null;
  if (!is_array($d)) $d = [];
  $d += ['memos' => [], 'cats' => [], 'catsRev' => 0, 'subs' => []];
  $changed = false;
  $result = $fn($d, $changed);
  if ($changed) {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($d, JSON_UNESCAPED_UNICODE));
    fflush($fp);
  }
  flock($fp, LOCK_UN);
  fclose($fp);
  return $result;
}

/* ---------------- VAPID 鍵 ---------------- */
function ec_pub_raw($details) {
  return "\x04" . str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT);
}
function new_ec_key() {
  $k = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
  if (!$k) throw new Exception('鍵を作れませんでした（openssl）');
  return $k;
}
function generate_vapid() {
  $k = new_ec_key();
  openssl_pkey_export($k, $pem);
  return ['pub' => b64u_enc(ec_pub_raw(openssl_pkey_get_details($k))), 'priv' => $pem];
}
function pub_raw_to_pem($raw65) {
  $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $raw65;
  return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

/* ES256 の署名は DER で返ってくるので、JWT 用に r||s（64バイト）へ直す */
function der_sig_to_raw($der) {
  $pos = 2;
  if (ord($der[1]) & 0x80) $pos += ord($der[1]) & 0x7f;
  $out = '';
  for ($i = 0; $i < 2; $i++) {
    if (ord($der[$pos]) !== 0x02) throw new Exception('署名の形式が不正');
    $len = ord($der[$pos + 1]);
    $int = substr($der, $pos + 2, $len);
    $pos += 2 + $len;
    $int = ltrim($int, "\0");
    $out .= str_pad($int, 32, "\0", STR_PAD_LEFT);
  }
  return $out;
}
function vapid_jwt($endpoint, $cfg) {
  $u = parse_url($endpoint);
  $aud = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
  $head = b64u_enc(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
  $claims = b64u_enc(json_encode(['aud' => $aud, 'exp' => time() + 12 * 3600, 'sub' => $cfg['subject']], JSON_UNESCAPED_SLASHES));
  $input = $head . '.' . $claims;
  if (!openssl_sign($input, $der, $cfg['vapid']['priv'], OPENSSL_ALGO_SHA256)) throw new Exception('署名に失敗');
  return $input . '.' . b64u_enc(der_sig_to_raw($der));
}

/* ---------------- Web Push の暗号化（RFC 8291 / aes128gcm） ---------------- */
function hmac($key, $data) { return hash_hmac('sha256', $data, $key, true); }
function webpush_encrypt($payload, $p256dhB64, $authB64) {
  $uaPub = b64u_dec($p256dhB64);
  $auth = b64u_dec($authB64);
  if (!$uaPub || strlen($uaPub) !== 65 || !$auth) throw new Exception('購読情報が不正');
  $eph = new_ec_key();
  $asPub = ec_pub_raw(openssl_pkey_get_details($eph));
  $shared = openssl_pkey_derive(openssl_pkey_get_public(pub_raw_to_pem($uaPub)), $eph, 32);
  if ($shared === false) throw new Exception('鍵交換に失敗');
  $prkKey = hmac($auth, $shared);
  $ikm = hmac($prkKey, "WebPush: info\0" . $uaPub . $asPub . "\x01");
  $salt = random_bytes(16);
  $prk = hmac($salt, $ikm);
  $cek = substr(hmac($prk, "Content-Encoding: aes128gcm\0\x01"), 0, 16);
  $nonce = substr(hmac($prk, "Content-Encoding: nonce\0\x01"), 0, 12);
  $ct = openssl_encrypt($payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
  return $salt . pack('N', 4096) . chr(65) . $asPub . $ct . $tag;
}

/* 1件送る。戻り値は HTTP ステータス（0 は通信失敗） */
function webpush_send($sub, $payloadArr, $cfg) {
  $body = webpush_encrypt(json_encode($payloadArr, JSON_UNESCAPED_UNICODE), $sub['keys']['p256dh'], $sub['keys']['auth']);
  $ch = curl_init($sub['endpoint']);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => [
      'Authorization: vapid t=' . vapid_jwt($sub['endpoint'], $cfg) . ', k=' . $cfg['vapid']['pub'],
      'Content-Encoding: aes128gcm',
      'Content-Type: application/octet-stream',
      'TTL: 86400',
      'Urgency: high',
    ],
  ]);
  curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return $code;
}

/* ---------------- くり返しの次の回 ---------------- */
function next_repeat($ms, $rep) {
  $tz = new DateTimeZone('Asia/Tokyo');
  $d = (new DateTime('@' . intdiv($ms, 1000)))->setTimezone($tz);
  $now = now_ms();
  for ($guard = 0; $guard < 1000; $guard++) {
    if ($rep === 'daily') $d->modify('+1 day');
    elseif ($rep === 'weekdays') { do { $d->modify('+1 day'); } while ((int) $d->format('N') >= 6); }
    elseif ($rep === 'weekly') $d->modify('+7 days');
    elseif ($rep === 'monthly') $d->modify('+1 month');
    else return null;
    if ($d->getTimestamp() * 1000 > $now) break;
  }
  return $d->getTimestamp() * 1000;
}

/* ---------------- 時間が来たリマインドを送る（cron から毎分呼ぶ） ---------------- */
function run_reminders_locked(&$d, &$changed, $cfg) {
  $now = now_ms();
  $sent = 0;
  $catName = [];
  foreach ($d['cats'] as $c) if (isset($c['id'])) $catName[$c['id']] = ($c['emoji'] ?? '') . ' ' . ($c['name'] ?? '');
  foreach ($d['memos'] as &$m) {
    if (!empty($m['deleted']) || !empty($m['done']) || empty($m['remind']) || !empty($m['notified'])) continue;
    if ($m['remind'] > $now) continue;
    $title = '🔔 ' . trim($catName[$m['cat'] ?? ''] ?? 'メモ');
    $first = mb_substr(explode("\n", (string) ($m['text'] ?? ''))[0], 0, 80);
    if (!empty($m['by'])) $first .= '（' . $m['by'] . '）';
    $payload = ['title' => $title, 'body' => $first, 'id' => $m['id']];
    $onlyMe = ($m['notify'] ?? 'all') === 'me';
    foreach ($d['subs'] as $i => $s) {
      if ($onlyMe && ($s['device'] ?? '') !== ($m['owner'] ?? '')) continue;
      try {
        $code = webpush_send($s, $payload, $cfg);
        if ($code === 404 || $code === 410) { unset($d['subs'][$i]); }   // 解除された端末
        elseif ($code >= 200 && $code < 300) $sent++;
      } catch (Exception $e) { /* 1台の失敗で全体を止めない */ }
    }
    $d['subs'] = array_values($d['subs']);
    if (!empty($m['repeat']) && !empty($m['resume'])) { $m['remind'] = $m['resume']; unset($m['resume']); $m['notified'] = false; }
    elseif (!empty($m['repeat'])) { $m['remind'] = next_repeat((int) $m['remind'], $m['repeat']); $m['notified'] = false; }
    else $m['notified'] = true;
    $m['rev'] = $now;
    $changed = true;
  }
  unset($m);
  return $sent;
}
function run_reminders() {
  $cfg = load_config();
  if (!$cfg) return 0;
  return with_store(function (&$d, &$changed) use ($cfg) { return run_reminders_locked($d, $changed, $cfg); });
}
