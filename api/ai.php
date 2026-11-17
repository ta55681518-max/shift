<?php
/* ============================================================
   串焼KEMURI屋 AIの窓口（サーバー側・Xserver版）  /api/ai
   netlify/functions/ai.js と同じ動き。
   ・合言葉（kemuri_pass）が無ければ門前払い
   ・task は決まったものだけ。自由な文章は投げられない
   ・モデルと上限トークンはサーバー側で固定
   【設定】kemuriya-shuri.com/kemuri-private/config.php
     return ['openai_api_key' => 'sk-...', 'kemuri_pass' => '合言葉', 'openai_model' => 'gpt-4o-mini'];
   ============================================================ */
declare(strict_types=1);
require __DIR__ . '/_common.php';

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_BODY = 200 * 1024;
const MAX_OUT_TOKENS = 1500;
const MAX_OUT_EXTRACT = 4000;

$COMMON = implode("\n", [
  'あなたは沖縄の串焼き居酒屋「串焼KEMURI屋」の運営を手伝うアシスタントです。',
  '回答は日本語。お店のオーナー（ITの専門家ではない）が読む前提で、短く具体的に書きます。',
  '数字は与えられたデータだけから出し、勝手に作らないこと。分からないことは「分からない」と書きます。',
]);

function strip_fence(string $t): string {
  $s = trim($t);
  if (preg_match('/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/u', $s, $m)) $s = trim($m[1]);
  if ($s === '' || $s[0] !== '{') {
    $i = strpos($s, '{'); $j = strrpos($s, '}');
    if ($i !== false && $j !== false && $j > $i) $s = substr($s, $i, $j - $i + 1);
  }
  return $s;
}
function str_of($v): string { return is_scalar($v) ? (string)$v : ''; }
function cut(string $s, int $n): string { return mb_substr($s, 0, $n, 'UTF-8'); }

function build_messages(string $task, array $p, string $COMMON): array {
  switch ($task) {
    case 'costs': {
      $text = cut(str_of($p['text'] ?? ''), 20000);
      if (trim($text) === '') throw new InvalidArgumentException('単価のテキストが空です');
      return [[ 'role' => 'system', 'content' => $COMMON . "\n" . implode("\n", [
          '仕入先からの見積もりや、メモ書きの単価リストを読み取って、きれいな表に直す作業をします。',
          '出力は必ず次のJSONだけ：',
          '{"rows":[{"name":"商品名","unit":"単位","price":数値,"note":"補足","sure":true/false}],"skipped":["読めなかった行"]}',
          '・name … 商品名。余計な記号や番号は外す',
          '・unit … kg / 袋 / 本 / 個 / ケース など。書かれていなければ ""',
          '・price … 1単位あたりの仕入価格（円、税抜か税込かは問わない）。数値のみ',
          '・note … 「税込」「10kg入り」など、値段の前提が書かれていれば入れる。無ければ ""',
          '・sure … 読み取りに自信があれば true、推測が入っていれば false',
          '・合計行・見出し行・日付だけの行は rows に入れない',
          '・1つも読み取れなければ rows は空配列にする',
        ]) ],
        [ 'role' => 'user', 'content' => "次の内容から単価を読み取ってください。\n\n" . $text ]];
    }
    case 'recipes': {
      $text = cut(str_of($p['text'] ?? ''), 20000);
      if (trim($text) === '') throw new InvalidArgumentException('レシピのテキストが空です');
      $known = array_slice(array_map('str_of', is_array($p['materials'] ?? null) ? $p['materials'] : []), 0, 300);
      $lines = [
        'メニューのレシピ（作り方・材料表）を読み取って、材料と分量の表に直す作業をします。',
        '出力は必ず次のJSONだけ：',
        '{"recipes":[{"name":"メニュー名","parts":[{"name":"材料名","qty":数値,"unit":"単位"}],"sure":true/false}],"skipped":["読めなかった行"]}',
        '・qty … メニュー1つ（1皿・1人前）あたりの分量。数値のみ',
        '・unit … g / kg / ml / 個 / 本 / 枚 など。書かれていなければ ""',
        '  「大さじ1」「少々」のような分量は、おおよそのグラム数に直し、sure を false にする',
        '・調味料や水など、原価にほぼ影響しないものは入れなくてよい',
        '・1つのメニューに複数の材料があれば parts に並べる',
        '・sure … 分量まではっきり書かれていれば true、推測が入れば false',
        '・作り方の手順文は無視して、材料と分量だけを拾う',
      ];
      if ($known) $lines[] = '・材料名は、できるだけ次の在庫の名前に合わせること：' . implode('、', $known);
      return [[ 'role' => 'system', 'content' => $COMMON . "\n" . implode("\n", $lines) ],
        [ 'role' => 'user', 'content' => "次の内容からレシピを読み取ってください。\n\n" . $text ]];
    }
    case 'analyze': {
      /* {} と [] を取り違えないよう、元のJSONをオブジェクトのまま読み直したものを使う */
      $o = $GLOBALS['REQ_OBJ'] ?? null;
      $d = (is_object($o) && isset($o->payload) && is_object($o->payload) && isset($o->payload->data)) ? $o->payload->data : (object)[];
      $body = cut(json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 60000);
      return [[ 'role' => 'system', 'content' => $COMMON . "\n" . implode("\n", [
          'お店の売上データを見て、オーナーが明日から動けることだけを書きます。',
          '出力は必ず次のJSONだけ：',
          '{"summary":"全体の要約（2〜3文）",',
          ' "good":[{"name":"商品名","why":"伸びている理由や特徴"}],',
          ' "bad":[{"name":"商品名","why":"落ちている・出ていない点"}],',
          ' "cost":[{"name":"商品名","why":"原価率で気になる点"}],',
          ' "risk":[{"name":"商品名","why":"欠品しそうな理由"}],',
          ' "todo":["明日やるとよいこと"],',
          ' "caution":["データ上の注意点（期間が短い・まとめて入っている等）"]}',
          '・各配列は最大5件。該当が無ければ空配列',
          '・原価が未入力(0)の商品について原価率を語らないこと',
          '・「まとめて入っている日」がある場合、日別の傾向は断定せず caution に書くこと',
        ]) ],
        [ 'role' => 'user', 'content' => "次のデータを見て分析してください。\n\n" . $body ]];
    }
    case 'ping':
      return [[ 'role' => 'system', 'content' => '「OK」とだけ返してください。' ], [ 'role' => 'user', 'content' => 'ping' ]];
  }
  throw new DomainException('unknown');
}
$MAXTOK = ['costs' => MAX_OUT_EXTRACT, 'recipes' => MAX_OUT_EXTRACT, 'analyze' => MAX_OUT_TOKENS, 'ping' => 20];

/* ---------- 本体 ---------- */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }
if ($method !== 'POST') kemuri_json(405, ['error' => 'POSTで呼んでください']);

$cfg = kemuri_config();
$key = trim(str_of($cfg['openai_api_key'] ?? ''));
$pass = trim(str_of($cfg['kemuri_pass'] ?? ''));
$SETUP = 'Xserverのファイルマネージャで kemuriya-shuri.com/kemuri-private/config.php を確認してください。';
if ($pass === '') kemuri_json(500, ['error' => 'サーバーに合言葉（kemuri_pass）が設定されていません。' . $SETUP, 'setup' => true]);
if ($key === '')  kemuri_json(500, ['error' => 'サーバーにOpenAIのキー（openai_api_key）が設定されていません。' . $SETUP, 'setup' => true]);

$given = trim(str_of($_SERVER['HTTP_X_KEMURI_PASS'] ?? ''));
if (!hash_equals($pass, $given)) kemuri_json(401, ['error' => '合言葉が違います。ダッシュボードの設定を確認してください', 'auth' => true]);

$raw = file_get_contents('php://input') ?: '';
if (strlen($raw) > MAX_BODY) kemuri_json(413, ['error' => '送るデータが大きすぎます。期間を短くして試してください']);
if (kemuri_rate_limited('ai', 20, 60)) kemuri_json(429, ['error' => '短い時間に呼びすぎです。1分ほど待ってからもう一度お願いします']);

$req = json_decode($raw === '' ? '{}' : $raw, true);
$GLOBALS['REQ_OBJ'] = json_decode($raw === '' ? '{}' : $raw);
if (!is_array($req)) kemuri_json(400, ['error' => '送られた内容を読み取れませんでした']);
$task = str_of($req['task'] ?? '');
if (!isset($MAXTOK[$task])) kemuri_json(400, ['error' => '知らない依頼です: ' . cut($task, 40)]);

try { $messages = build_messages($task, is_array($req['payload'] ?? null) ? $req['payload'] : [], $COMMON); }
catch (Throwable $e) { kemuri_json(400, ['error' => $e->getMessage() ?: '材料が足りません']); }

$model = trim(str_of($cfg['openai_model'] ?? '')) ?: DEFAULT_MODEL;
$wantJson = $task !== 'ping';
$body = ['model' => $model, 'messages' => $messages, 'max_tokens' => $MAXTOK[$task], 'temperature' => 0.2];
if ($wantJson) $body['response_format'] = ['type' => 'json_object'];

$ch = curl_init('https://api.openai.com/v1/chat/completions');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60, CURLOPT_CONNECTTIMEOUT => 10,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $key],
  CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
]);
$text = curl_exec($ch);
$status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);
if ($text === false) kemuri_json(502, ['error' => 'OpenAIに繋がりませんでした。少し待ってもう一度お試しください']);

if ($status < 200 || $status >= 300) {
  $j = json_decode($text, true);
  $detail = is_array($j) ? str_of($j['error']['message'] ?? '') : cut($text, 200);
  $msg = $status === 401 ? 'OpenAIのキーが正しくないようです。config.php の openai_api_key を確認してください'
    : ($status === 429 && preg_match('/quota|billing|insufficient/i', $detail) ? 'OpenAIの残高が足りません。platform.openai.com でクレジットを追加してください'
    : ($status === 429 ? 'OpenAIが混み合っています。少し待ってもう一度お試しください'
    : ($status === 404 || preg_match('/model/i', $detail) ? 'モデル「' . $model . '」が使えませんでした。config.php の openai_model で別のモデルを指定できます'
    : 'OpenAIからエラーが返りました')));
  kemuri_json(502, ['error' => $msg, 'status' => $status, 'detail' => cut($detail, 300), 'model' => $model]);
}

$data = json_decode($text, true);
if (!is_array($data)) kemuri_json(502, ['error' => 'OpenAIの返事を読み取れませんでした']);
$choice = $data['choices'][0] ?? [];
$finish = str_of($choice['finish_reason'] ?? '');
$content = $choice['message']['content'] ?? null;
if (!is_string($content) || $content === '') kemuri_json(502, ['error' => 'OpenAIから中身が返りませんでした（' . ($finish ?: '理由不明') . '）', 'finish' => $finish]);

$result = $content;
if ($wantJson) {
  if ($finish === 'length') kemuri_json(502, [
    'error' => '内容が多すぎて、AIの返事が途中で切れました。貼り付ける量を半分くらいに減らして、何回かに分けてお試しください',
    'finish' => $finish, 'raw' => mb_substr($content, -200, null, 'UTF-8')]);
  $result = json_decode(strip_fence($content));
  if (!is_object($result) && !is_array($result)) kemuri_json(502, ['error' => 'AIの返事が期待した形ではありませんでした', 'finish' => $finish, 'raw' => cut($content, 400)]);
}
$u = $data['usage'] ?? [];
kemuri_json(200, ['ok' => true, 'task' => $task, 'result' => $result, 'model' => str_of($data['model'] ?? '') ?: $model,
  'usage' => ['in' => (int)($u['prompt_tokens'] ?? 0), 'out' => (int)($u['completion_tokens'] ?? 0)]]);
