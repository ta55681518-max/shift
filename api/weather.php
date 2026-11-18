<?php
/* ============================================================
   串焼KEMURI屋 那覇の過去の天気（サーバー側・Xserver版）  /api/weather?ym=2025-10
   netlify/functions/weather.js と同じ動き。
   ・地点は那覇に固定。受け取るのは年月（YYYY-MM）だけ
   ・気象庁への負荷を小さくする：過ぎた月は30日、今月は3時間、
     サーバーの中（公開フォルダの外）に控えを置いて使い回す
   ・ページの形が変わっていたら、推測で埋めずに «読めませんでした» を返す
   【出典】気象庁ホームページ（過去の気象データ検索）。数値は加工して表示する
   ============================================================ */
declare(strict_types=1);
require __DIR__ . '/_common.php';

const STATION_NAME = '那覇';
const PREC_NO = '91';
const BLOCK_NO = '47936';
const SOURCE = '気象庁ホームページ（過去の気象データ検索・那覇）';
const BASE = 'https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php';
const MIN_YEAR = 2022;

function jst_ym(): string { return gmdate('Y-m', time() + 9 * 3600); }

/* 文字の部分（タグの外）の後始末：よく出る記号を戻し、空白をつめる */
function clean_text(string $t): string {
  $s = str_replace(['&nbsp;', '&lt;', '&gt;', '&amp;'], [' ', '<', '>', '&'], $t);
  return trim((string)preg_replace('/\s+/u', ' ', $s));
}

/* ------------------------------------------------------------
   HTML を頭から順に読み、«本物のタグ» «文字» を区別して並べる（Codex指摘26）。
   netlify/functions/weather.js の tokenize と同じ決まり。
   ・コメント（<!-- -->）の中は読まない。標準の形だけ受け付け、変則の形・閉じていないものは bad
   ・タグの設定値（引用符の中）は設定値として読む。中に <tr> などの文字があってもタグにしない
   ・script / style / template / noscript などの中身は読み飛ばす。入れ子・自分で閉じる形は bad
   ・CDATA・svg・math は扱わない（bad）
   返り値：[['t'=>'open','name'=>..,'attrs'=>[..],'self'=>bool] | ['t'=>'close','name'=>..] | ['t'=>'text','s'=>..] | ['t'=>'bad','why'=>..]]
   ※ 文字は UTF-8 のバイト列のまま扱う（区切りに使う記号はすべて1バイトなので、日本語を壊さない）
   ------------------------------------------------------------ */
const WX_RAW = ['script' => 1, 'style' => 1, 'textarea' => 1, 'title' => 1, 'template' => 1, 'noscript' => 1, 'iframe' => 1, 'noembed' => 1, 'noframes' => 1, 'xmp' => 1];
const WX_FOREIGN = ['svg' => 1, 'math' => 1];
function wx_alpha(string $c): bool { return ($c >= 'a' && $c <= 'z') || ($c >= 'A' && $c <= 'Z'); }
function wx_space(string $c): bool { return $c === ' ' || $c === "\n" || $c === "\t" || $c === "\r" || $c === "\f"; }
function wx_tokenize(string $h): array {
  $n = strlen($h); $out = []; $i = 0; $textFrom = 0;
  $flush = function (int $to) use (&$out, &$textFrom, $h) { if ($to > $textFrom) $out[] = ['t' => 'text', 's' => substr($h, $textFrom, $to - $textFrom)]; };
  $bad = function (string $why) use (&$out) { $out[] = ['t' => 'bad', 'why' => $why]; return $out; };
  while ($i < $n) {
    if ($h[$i] !== '<') { $i++; continue; }
    $c = $i + 1 < $n ? $h[$i + 1] : '';
    if (substr_compare($h, '<!--', $i, 4) === 0) {                     // コメント
      $flush($i);
      if (substr($h, $i, 5) === '<!-->' || substr($h, $i, 6) === '<!--->') return $bad('コメントの形が想定と違います');
      $e = $i + 4 <= $n ? strpos($h, '-->', $i + 4) : false;
      if ($e === false) return $bad('コメントが閉じていません');
      $odd = strpos($h, '--!>', $i + 4);
      if ($odd !== false && $odd < $e) return $bad('コメントの形が想定と違います');
      $i = $e + 3; $textFrom = $i; continue;
    }
    if ($c === '!' || $c === '?') {                                    // <!DOCTYPE ...> など
      $flush($i);
      if (strtoupper(substr($h, $i, 9)) === '<![CDATA[') return $bad('CDATA は扱えません');
      $e = strpos($h, '>', $i);
      if ($e === false) return $bad('宣言が閉じていません');
      $i = $e + 1; $textFrom = $i; continue;
    }
    if ($c === '/') {                                                  // 閉じタグ
      if (!($i + 2 < $n) || !wx_alpha($h[$i + 2])) {                   // </ のあとが文字でない：ブラウザはコメント扱いにする
        $flush($i);
        $e = strpos($h, '>', $i);
        if ($e === false) return $bad('タグが閉じていません');
        $i = $e + 1; $textFrom = $i; continue;
      }
      $flush($i);
      $j = $i + 2;
      while ($j < $n && !wx_space($h[$j]) && $h[$j] !== '>' && $h[$j] !== '/') $j++;
      $name = strtolower(substr($h, $i + 2, $j - $i - 2));
      $e = strpos($h, '>', $j);
      if ($e === false) return $bad('閉じタグが途中で終わっています');
      if (trim(substr($h, $j, $e - $j), " \n\t\r\f") !== '') $out[] = ['t' => 'bad', 'why' => '閉じタグの形が想定と違います（' . $name . '）'];
      $out[] = ['t' => 'close', 'name' => $name];
      $i = $e + 1; $textFrom = $i; continue;
    }
    if ($c === '' || !wx_alpha($c)) { $i++; continue; }                // ただの «<» の文字
    /* 開始タグ */
    $flush($i);
    $j = $i + 1;
    while ($j < $n && !wx_space($h[$j]) && $h[$j] !== '>' && $h[$j] !== '/') $j++;
    $name = strtolower(substr($h, $i + 1, $j - $i - 1));
    $attrs = []; $self = false; $closed = false;
    while ($j < $n) {
      while ($j < $n && wx_space($h[$j])) $j++;
      if ($j >= $n) break;
      if ($h[$j] === '>') { $j++; $closed = true; break; }
      if ($h[$j] === '/') { if ($j + 1 < $n && $h[$j + 1] === '>') { $self = true; $j += 2; $closed = true; break; } $j++; continue; }
      $a = $j;
      while ($j < $n && !wx_space($h[$j]) && $h[$j] !== '=' && $h[$j] !== '>' && $h[$j] !== '/') $j++;
      if ($j === $a) { $j++; continue; }                               // 先頭が «=» の設定名など
      $an = strtolower(substr($h, $a, $j - $a));
      $av = '';
      while ($j < $n && wx_space($h[$j])) $j++;
      if ($j < $n && $h[$j] === '=') {
        $j++;
        while ($j < $n && wx_space($h[$j])) $j++;
        if ($j < $n && ($h[$j] === '"' || $h[$j] === "'")) {
          $q = $h[$j]; $e = $j + 1 <= $n ? strpos($h, $q, $j + 1) : false;
          if ($e === false) return $bad('設定値の引用符が閉じていません');
          $av = substr($h, $j + 1, $e - $j - 1); $j = $e + 1;
        } else {
          $a = $j;
          while ($j < $n && !wx_space($h[$j]) && $h[$j] !== '>') $j++;
          $av = substr($h, $a, $j - $a);
        }
      }
      if (!array_key_exists($an, $attrs)) $attrs[$an] = $av;           // 同じ名前は最初のものが有効
    }
    if (!$closed) return $bad('タグが途中で終わっています');
    if (isset(WX_FOREIGN[$name])) return $bad($name . ' は扱えません');
    $out[] = ['t' => 'open', 'name' => $name, 'attrs' => $attrs, 'self' => $self];
    $i = $j; $textFrom = $i;
    if (isset(WX_RAW[$name])) {                                        // 中身は読み飛ばす
      if ($self) return $bad($name . ' の形が想定と違います');
      $rest = substr($h, $i);
      if (!preg_match('/<\/' . $name . '[\s>\/]/i', $rest, $mm, PREG_OFFSET_CAPTURE)) return $bad($name . ' が閉じていません');
      $at = $mm[0][1];
      if (preg_match('/<' . $name . '[\s>\/]/i', substr($rest, 0, $at))) return $bad($name . ' が入れ子になっています');
      $i += $at; $textFrom = $i;                                       // 中身は捨てる（文字としても使わない）
    }
  }
  $flush($n);
  return $out;
}
function num_of(string $s): ?float {
  return preg_match('/^-?\d+(?:\.\d+)?/', $s, $m) ? (float)$m[0] : null;
}
function blankish(string $s): bool { return (bool)preg_match('/^[-\/×#\s]*$/u', $s); }

const WX_TABLE_PARTS = ['tbody' => 1, 'thead' => 1, 'tfoot' => 1, 'caption' => 1, 'colgroup' => 1, 'col' => 1];
/* セルの中に置いてよい飾りのタグ（文字だけ拾う）。ここに無いタグが表の中にあれば、想定外として全体を失敗にする */
const WX_CELL_INLINE = ['a' => 1, 'div' => 1, 'span' => 1, 'br' => 1, 'img' => 1, 'b' => 1, 'strong' => 1, 'i' => 1, 'em' => 1, 'u' => 1, 'font' => 1, 'small' => 1, 'sup' => 1, 'sub' => 1, 'p' => 1, 'nobr' => 1, 'wbr' => 1];

/* ページのHTML → ['days' => ['01' => [...]], 'count' => n]。形が違えば例外
   方針：推測で埋めない。読めない形・想定と違う形は、1か所でも全体を失敗にする
   （netlify/functions/weather.js の parse と同じ決まり） */
function parse_jma(string $html, string $ym, bool $whole = false): array {
  $toks = wx_tokenize($html);
  /* 0) 読めない部分・扱わない書き方がページのどこかに1つでもあれば、全体を失敗にする */
  foreach ($toks as $k) if ($k['t'] === 'bad') throw new RuntimeException('ページに読めない部分があります（' . $k['why'] . '）');
  /* 1) コメントや設定値の外にある «本物の» 表のうち、id が tablefix1 のものを選ぶ */
  $starts = [];
  foreach ($toks as $i => $k) if ($k['t'] === 'open' && $k['name'] === 'table' && ($k['attrs']['id'] ?? null) === 'tablefix1') $starts[] = $i;
  if (!count($starts)) throw new RuntimeException('表が見つかりません');
  if (count($starts) > 1) throw new RuntimeException('同じ名前の表が2つ以上あります');
  if ($toks[$starts[0]]['self']) throw new RuntimeException('表の形が想定と違います');

  /* 2) 表の終わりまで、行・セルの対応と入れ子を確かめながら読む */
  $rows = []; $row = null; $cell = null; $ended = false;
  for ($i = $starts[0] + 1, $nt = count($toks); $i < $nt; $i++) {
    $k = $toks[$i];
    if ($k['t'] === 'text') { if ($cell !== null) $cell['text'] .= $k['s']; continue; }
    $nm = $k['name'];
    if ($k['t'] === 'open') {
      if ($nm === 'table') throw new RuntimeException('表の中に別の表があります');
      if ($nm === 'tr') {
        if ($row !== null || $cell !== null || $k['self']) throw new RuntimeException('表の行のタグが対応していません');
        $row = ['td' => [], 'th' => 0, 'heads' => []];
      } elseif ($nm === 'td' || $nm === 'th') {
        if ($row === null || $cell !== null || $k['self']) throw new RuntimeException('表のセルのタグが対応していません');
        $cell = ['kind' => $nm, 'text' => ''];
      } elseif (isset(WX_TABLE_PARTS[$nm])) {
        if ($row !== null || $cell !== null) throw new RuntimeException('表の行の中に、行のまとまりのタグがあります');
      } elseif (!($cell !== null && isset(WX_CELL_INLINE[$nm]))) {
        throw new RuntimeException('表の中に想定外のタグがあります（' . $nm . '）');
      }
      continue;
    }
    /* 閉じタグ */
    if ($nm === 'table') {
      if ($row !== null || $cell !== null) throw new RuntimeException('表が、行やセルの途中で終わっています');
      $ended = true; break;
    }
    if ($nm === 'tr') {
      if ($row === null || $cell !== null) throw new RuntimeException('表の行のタグが対応していません');
      $rows[] = $row; $row = null;
    } elseif ($nm === 'td' || $nm === 'th') {
      if ($cell === null || $cell['kind'] !== $nm) throw new RuntimeException('表のセルのタグが対応していません');
      if ($nm === 'td') $row['td'][] = clean_text($cell['text']); else { $row['th']++; $row['heads'][] = clean_text($cell['text']); }
      $cell = null;
    } elseif (isset(WX_TABLE_PARTS[$nm])) {
      if ($row !== null || $cell !== null) throw new RuntimeException('表の行の中に、行のまとまりのタグがあります');
    } elseif (!($cell !== null && isset(WX_CELL_INLINE[$nm]))) {
      throw new RuntimeException('表の中に想定外の閉じタグがあります（' . $nm . '）');
    }
  }
  if (!$ended) throw new RuntimeException('表が閉じていません');

  /* 3) 見出し（本物の見出しセルの文字だけで確かめる）：あること・左からの並び */
  $heads = [];
  foreach ($rows as $r) foreach ($r['heads'] as $t) $heads[] = $t;
  $at = function (string $w) use ($heads): int { foreach ($heads as $i => $t) if (strpos($t, $w) !== false) return $i; return -1; };
  $iR = $at('降水量'); $iW = $at('風向・風速'); $iG = $at('天気概況');
  if ($iR < 0 || $iG < 0 || $at('最大瞬間風速') < 0) throw new RuntimeException('表の見出しが想定と違います');
  if (!($iR < $iW && $iW < $iG)) throw new RuntimeException('表の見出しの並びが想定と違います');

  /* 4) 行の検査。見出しとして飛ばしてよいのは «td が1つも無い行» だけ */
  $y = (int)substr($ym, 0, 4); $mo = (int)substr($ym, 5, 2);
  $last = (int)gmdate('t', gmmktime(0, 0, 0, $mo, 1, $y));
  $days = []; $count = 0;
  foreach ($rows as $r) {
    $c = $r['td'];
    if (!count($c)) continue;
    if ($r['th']) throw new RuntimeException('日の行に見出しのセルが混ざっています');
    if (!preg_match('/^\d{1,2}$/D', $c[0])) throw new RuntimeException('日付のセルが想定と違います（' . mb_substr($c[0], 0, 10, 'UTF-8') . '）');
    if (count($c) !== 21) throw new RuntimeException('日の行の列の数が想定と違います（' . $c[0] . '日）');
    $d = (int)$c[0];
    if ($d < 1 || $d > $last) throw new RuntimeException('日付が想定と違います（' . $c[0] . '）');
    $key = sprintf('%02d', $d);
    if (isset($days[$key])) throw new RuntimeException('同じ日が2回あります（' . $d . '日）');
    $rain = num_of($c[3]);
    $days[$key] = [
      'rain' => $rain === null ? ($c[3] === '--' ? 0 : null) : $rain,
      'wind' => num_of($c[12]), 'windDir' => $c[13],
      'gust' => num_of($c[14]), 'gustDir' => $c[15],
      'day' => blankish($c[19]) ? '' : $c[19],
      'night' => blankish($c[20]) ? '' : $c[20],
    ];
    $count++;
  }
  if (!$count) throw new RuntimeException('日ごとの行が読めません');
  /* 1日から続いていること。過ぎた月（whole）は、月の日数ぶんそろっていること */
  for ($i = 1; $i <= $count; $i++) if (!isset($days[sprintf('%02d', $i)])) throw new RuntimeException('日が抜けています（' . $i . '日）');
  if ($whole && $count !== $last) throw new RuntimeException('月の日数ぶんそろっていません（' . $count . '/' . $last . '日）');
  return ['days' => $days, 'count' => $count];
}

/* 試験のときは、ここより上の関数だけを使う（WX_LIB_ONLY を定義して読み込む） */
if (defined('WX_LIB_ONLY')) return;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') kemuri_json(405, ['ok' => false, 'why' => 'GET だけ受け付けます']);
$ym = is_string($_GET['ym'] ?? null) ? $_GET['ym'] : '';
if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $ym)) kemuri_json(400, ['ok' => false, 'why' => '年月（YYYY-MM）を指定してください']);
$nowYm = jst_ym();
if ((int)substr($ym, 0, 4) < MIN_YEAR || $ym > $nowYm) kemuri_json(400, ['ok' => false, 'why' => 'その年月は対象外です']);

$past = $ym < $nowYm;
$cache = $past ? 'public, max-age=86400' : 'public, max-age=3600';
$ttl = $past ? 30 * 86400 : 3 * 3600;

$dir = kemuri_private_dir() . '/tmp/weather';
if (!is_dir($dir)) @mkdir($dir, 0700, true);
$memo = $dir . '/' . $ym . '.json';
if (is_file($memo) && time() - filemtime($memo) < $ttl) {
  $hit = json_decode((string)file_get_contents($memo), true);
  if (is_array($hit)) kemuri_json(200, $hit, $cache);
}

if (kemuri_rate_limited('weather', 30, 60)) kemuri_json(429, ['ok' => false, 'why' => '少し時間をおいてから開いてください']);

$url = BASE . '?prec_no=' . PREC_NO . '&block_no=' . BLOCK_NO . '&year=' . (int)substr($ym, 0, 4) . '&month=' . (int)substr($ym, 5, 2) . '&day=&view=';
$ch = curl_init($url);
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 9, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_USERAGENT => 'KEMURIya-sales-calendar/1.0 (low-frequency; monthly page; cached)']);
$html = curl_exec($ch);
$status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$err = curl_error($ch);
curl_close($ch);
if ($html === false) kemuri_json(502, ['ok' => false, 'why' => '気象庁のページを読めませんでした（' . mb_substr($err, 0, 80, 'UTF-8') . '）']);
if ($status < 200 || $status >= 300) kemuri_json(502, ['ok' => false, 'why' => '気象庁のページを開けませんでした（' . $status . '）']);
try { $p = parse_jma((string)$html, $ym, $past); }
catch (Throwable $e) { kemuri_json(502, ['ok' => false, 'why' => '気象庁のページを読めませんでした（' . mb_substr($e->getMessage(), 0, 80, 'UTF-8') . '）']); }

$out = ['ok' => true, 'ym' => $ym, 'station' => STATION_NAME, 'source' => SOURCE, 'edited' => true, 'count' => $p['count'], 'days' => $p['days']];
@file_put_contents($memo, json_encode($out, JSON_UNESCAPED_UNICODE), LOCK_EX);
kemuri_json(200, $out, $cache);
