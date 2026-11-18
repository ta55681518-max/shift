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
/* 空白として扱うのは、半角の空白・タブ・改行（LF/CR）・改ページの5つだけ（JS版と同じ決まり。指摘A-2） */
function clean_text(string $t): string {
  $s = str_replace(['&nbsp;', '&lt;', '&gt;', '&amp;'], [' ', '<', '>', '&'], $t);
  $s = preg_replace('/[ \t\n\r\f]+/', ' ', $s);
  if (!is_string($s)) throw new RuntimeException('ページの文字が壊れています');
  return trim($s, ' ');
}

/* ------------------------------------------------------------
   HTML を頭から順に読み、«本物のタグ» «文字» を区別して並べる（Codex指摘26）。
   netlify/functions/weather.js の tokenize と同じ決まり。
   ・コメント（<!-- -->）の中は読まない。標準の形だけ受け付け、変則の形・閉じていないものは bad
   ・タグの設定値（引用符の中）は設定値として読む。中に <tr> などの文字があってもタグにしない
   ・script / style / title / noscript の中身は読み飛ばす。入れ子・自分で閉じる形は bad
   ・CDATA は扱わない（bad）。使ってよいタグの一覧（WX_PAGE_TAGS）に無いタグは bad（開始・終了とも）
   返り値：[['t'=>'open','name'=>..,'attrs'=>[..],'self'=>bool] | ['t'=>'close','name'=>..] | ['t'=>'text','s'=>..] | ['t'=>'bad','why'=>..]]
   ※ 文字は UTF-8 のバイト列のまま扱う（区切りに使う記号はすべて1バイトなので、日本語を壊さない）
   ------------------------------------------------------------ */
/* ページ全体で使ってよいタグ（指摘A-1）。ここに無いタグ（plaintext・template・svg・select など、
   HTML の読み方そのものを変えるものを含む）が1つでもあれば、ページ全体を «読めない» として止める。JS版と同じ一覧 */
const WX_PAGE_TAGS = ['html' => 1, 'head' => 1, 'body' => 1, 'title' => 1, 'meta' => 1, 'link' => 1, 'style' => 1, 'script' => 1, 'noscript' => 1,
  'div' => 1, 'span' => 1, 'p' => 1, 'a' => 1, 'img' => 1, 'br' => 1, 'hr' => 1, 'ul' => 1, 'ol' => 1, 'li' => 1, 'dl' => 1, 'dt' => 1, 'dd' => 1,
  'table' => 1, 'thead' => 1, 'tbody' => 1, 'tfoot' => 1, 'tr' => 1, 'td' => 1, 'th' => 1, 'caption' => 1, 'colgroup' => 1, 'col' => 1,
  'form' => 1, 'input' => 1, 'label' => 1, 'button' => 1, 'h1' => 1, 'h2' => 1, 'h3' => 1, 'h4' => 1, 'h5' => 1, 'h6' => 1,
  'header' => 1, 'footer' => 1, 'nav' => 1, 'main' => 1, 'section' => 1, 'article' => 1, 'center' => 1,
  'strong' => 1, 'b' => 1, 'em' => 1, 'i' => 1, 'u' => 1, 'small' => 1, 'sup' => 1, 'sub' => 1, 'font' => 1, 'nobr' => 1, 'wbr' => 1];
/* 中身を読み飛ばす要素（中のタグ文字はタグにしない） */
const WX_RAW = ['script' => 1, 'style' => 1, 'title' => 1, 'noscript' => 1];
/* 失敗の理由に出すタグの名前：半角の英数字とハイフンだけのときに、先頭20文字まで（JS版と同じ文言にするため） */
function wx_shown(string $name): string { return preg_match('/^[a-z0-9-]+$/D', $name) === 1 ? substr($name, 0, 20) : '名前に想定外の文字'; }
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
    if ($c === '!' || $c === '?') {                                    // 宣言など
      $flush($i);
      /* 受け付ける宣言は «<!doctype html>» の1つの形だけ（JS版と同じ。レビュー15） */
      if (preg_match('/^<!doctype[ \t\n\r\f]+html[ \t\n\r\f]*>/i', substr($h, $i, 64), $dm) !== 1) return $bad('宣言の形が想定と違います');
      $i += strlen($dm[0]); $textFrom = $i; continue;
    }
    if ($c === '/') {                                                  // 閉じタグ
      /* </ のあとが文字でない形（ブラウザはコメント扱いにする）は、扱わずに止める */
      if (!($i + 2 < $n) || !wx_alpha($h[$i + 2])) { $flush($i); return $bad('タグの形が想定と違います'); }
      $flush($i);
      $j = $i + 2;
      while ($j < $n && !wx_space($h[$j]) && $h[$j] !== '>' && $h[$j] !== '/') $j++;
      $name = strtolower(substr($h, $i + 2, $j - $i - 2));
      $e = strpos($h, '>', $j);
      if ($e === false) return $bad('閉じタグが途中で終わっています');
      if (trim(substr($h, $j, $e - $j), " \n\t\r\f") !== '') $out[] = ['t' => 'bad', 'why' => '閉じタグの形が想定と違います（' . wx_shown($name) . '）'];
      if (!isset(WX_PAGE_TAGS[$name])) return $bad('このタグは扱えません（' . wx_shown($name) . '）');
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
      /* 設定の名前が読めない（«=» で始まる）・名前に引用符や «<» がある → 直して読まずに止める（JS版と同じ。レビュー16） */
      if ($j === $a) return $bad('タグの設定の形が想定と違います');
      $an = strtolower(substr($h, $a, $j - $a));
      if (strpbrk($an, "\"'<") !== false) return $bad('タグの設定の形が想定と違います');
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
          /* 引用符なしの値：空・引用符や « < = ` » を含むものは、想定外の形として止める */
          if ($av === '' || strpbrk($av, "\"'<=`") !== false) return $bad('タグの設定の形が想定と違います');
        }
      }
      if (!array_key_exists($an, $attrs)) $attrs[$an] = $av;           // 同じ名前は最初のものが有効
    }
    if (!$closed) return $bad('タグが途中で終わっています');
    if (!isset(WX_PAGE_TAGS[$name])) return $bad('このタグは扱えません（' . wx_shown($name) . '）');
    $out[] = ['t' => 'open', 'name' => $name, 'attrs' => $attrs, 'self' => $self];
    $i = $j; $textFrom = $i;
    if (isset(WX_RAW[$name])) {                                        // 中身は読み飛ばす
      if ($self) return $bad($name . ' の形が想定と違います');
      $rest = substr($h, $i);
      if (!preg_match('/<\/' . $name . '[ \t\n\r\f>\/]/i', $rest, $mm, PREG_OFFSET_CAPTURE)) return $bad($name . ' が閉じていません');
      $at = $mm[0][1];
      if (preg_match('/<' . $name . '[ \t\n\r\f>\/]/i', substr($rest, 0, $at))) return $bad($name . ' が入れ子になっています');
      $i += $at; $textFrom = $i;                                       // 中身は捨てる（文字としても使わない）
    }
  }
  $flush($n);
  return $out;
}
/* 桁が多すぎる数字（15文字を超える）は、表の形がおかしいとみなして止める（指摘A-3。INF になって返事を作れなくなるのを防ぐ） */
function num_of(string $s): ?float {
  if (!preg_match('/^-?\d+(?:\.\d+)?/', $s, $m)) return null;
  if (strlen($m[0]) > 15) throw new RuntimeException('数値が想定と違います');
  return (float)$m[0];
}
function blankish(string $s): bool {
  $r = preg_match('/^[-\/×# \t\n\r\f]*$/u', $s);
  if ($r === false) throw new RuntimeException('ページの文字が壊れています');
  return $r === 1;
}

const WX_TABLE_PARTS = ['tbody' => 1, 'thead' => 1, 'tfoot' => 1, 'caption' => 1, 'colgroup' => 1, 'col' => 1];
/* セルの中に置いてよい飾りのタグ（文字だけ拾う）。ここに無いタグが表の中にあれば、想定外として全体を失敗にする */
const WX_CELL_INLINE = ['a' => 1, 'div' => 1, 'span' => 1, 'br' => 1, 'img' => 1, 'b' => 1, 'strong' => 1, 'i' => 1, 'em' => 1, 'u' => 1, 'font' => 1, 'small' => 1, 'sup' => 1, 'sub' => 1, 'p' => 1, 'nobr' => 1, 'wbr' => 1];

/* ページのHTML → ['days' => ['01' => [...]], 'count' => n]。形が違えば例外
   方針：推測で埋めない。読めない形・想定と違う形は、1か所でも全体を失敗にする
   （netlify/functions/weather.js の parse と同じ決まり） */
function parse_jma(string $html, string $ym, bool $whole = false): array {
  /* 文字が壊れている（UTF-8 として正しくない・置き換えの印 U+FFFD がある）・NUL がある → 読まずに止める（指摘A-2） */
  if (preg_match('//u', $html) !== 1 || strpos($html, "\xEF\xBF\xBD") !== false || strpos($html, "\0") !== false) throw new RuntimeException('ページの文字が壊れています');
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

/* 読み取り方式の版。読み取りの決まりを変えたら1つ進める（古い版で作った控えを使わないため） */
const WX_PARSER_VERSION = 6;

/* 返事（控え）の中身の検査：成功の形・年月・日数（count と行の数が同じ／1日から続く／月の日数を超えない／
   過ぎた月は月の日数ぶん）・各行の項目の形。parse_jma が成功として返す形だけを通す */
function wx_valid_body($b, string $ym, bool $whole): bool {
  if (!is_array($b) || ($b['ok'] ?? null) !== true || ($b['ym'] ?? null) !== $ym) return false;
  if (($b['station'] ?? null) !== STATION_NAME || ($b['source'] ?? null) !== SOURCE || ($b['edited'] ?? null) !== true) return false;
  $days = $b['days'] ?? null; $count = $b['count'] ?? null;
  if (!is_array($days) || !is_int($count) || $count < 1 || count($days) !== $count) return false;
  $last = (int)gmdate('t', gmmktime(0, 0, 0, (int)substr($ym, 5, 2), 1, (int)substr($ym, 0, 4)));
  if ($count > $last || ($whole && $count !== $last)) return false;
  $num = fn($v) => $v === null || ((is_int($v) || is_float($v)) && is_finite((float)$v));
  for ($i = 1; $i <= $count; $i++) {
    $r = $days[sprintf('%02d', $i)] ?? null;
    if (!is_array($r) || count($r) !== 7) return false;
    foreach (['rain', 'wind', 'gust'] as $k) if (!array_key_exists($k, $r) || !$num($r[$k])) return false;
    foreach (['windDir', 'gustDir', 'day', 'night'] as $k) if (!is_string($r[$k] ?? null)) return false;   /* 長さの上限は付けない（JS版と同じ受け方。レビュー16） */
  }
  return true;
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
  /* 控えは、いまの読み取り方式で作った・中身の形が正しいものだけ使う（wx_valid_body）。
     そうでないもの（古い方式の控え・日数の足りない控え・空・途中まで・別の月）は使わず、取り直す */
  if (is_array($hit) && ($hit['pv'] ?? null) === WX_PARSER_VERSION && is_array($hit['body'] ?? null) && wx_valid_body($hit['body'], $ym, $past)) kemuri_json(200, $hit['body'], $cache);
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
/* 返事を作れることを確かめてから、控えに置く（作れなければ成功にしない。空の控えも作らない。指摘A-3） */
/* 控えには、読み取り方式の版（pv）を付けて置く */
$json = wx_valid_body($out, $ym, $past) ? json_encode(['pv' => WX_PARSER_VERSION, 'body' => $out], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : false;
if (!is_string($json) || $json === '') kemuri_json(502, ['ok' => false, 'why' => '気象庁のページを読めませんでした（返事を作れません）']);
$tmp = $memo . '.' . bin2hex(random_bytes(4)) . '.tmp';
if (@file_put_contents($tmp, $json, LOCK_EX) === strlen($json)) { if (!@rename($tmp, $memo)) @unlink($tmp); } else { @unlink($tmp); }
kemuri_json(200, $out, $cache);
