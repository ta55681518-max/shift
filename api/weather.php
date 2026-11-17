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

function cell_text(string $html): string {
  $s = preg_replace('/<[^>]*>/u', '', $html);
  $s = str_replace(['&nbsp;', '&amp;', '&lt;', '&gt;'], [' ', '&', '<', '>'], $s);
  return trim(preg_replace('/\s+/u', ' ', $s));
}
function num_of(string $s): ?float {
  return preg_match('/^-?\d+(?:\.\d+)?/', $s, $m) ? (float)$m[0] : null;
}
function blankish(string $s): bool { return (bool)preg_match('/^[-\/×#\s]*$/u', $s); }

function parse_jma(string $html, string $ym, bool $whole = false): array {
  if (!preg_match('/<table[^>]*id=["\']tablefix1["\'][^>]*>([\s\S]*?)<\/table>/iu', $html, $m)) throw new RuntimeException('表が見つかりません');
  $body = $m[1];
  if (!preg_match('/天気概況/u', $body) || !preg_match('/最大瞬間風速/u', $body) || !preg_match('/降水量/u', $body)) throw new RuntimeException('表の見出しが想定と違います');
  /* 見出しの並び（左から 降水量 → 風向・風速 → 天気概況）も確かめる */
  $iR = strpos($body, '降水量'); $iW = strpos($body, '風向・風速'); $iG = strpos($body, '天気概況');
  if ($iR === false || $iW === false || $iG === false || !($iR < $iW && $iW < $iG)) throw new RuntimeException('表の見出しの並びが想定と違います');
  $y = (int)substr($ym, 0, 4); $mo = (int)substr($ym, 5, 2);
  $last = (int)gmdate('t', gmmktime(0, 0, 0, $mo, 1, $y));
  $days = []; $count = 0;
  preg_match_all('/<tr[^>]*>[\s\S]*?<\/tr>/iu', $body, $rows);
  foreach ($rows[0] as $tr) {
    preg_match_all('/<td[^>]*>[\s\S]*?<\/td>/iu', $tr, $tds);
    $c = array_map('cell_text', $tds[0]);
    if (!count($c) || !preg_match('/^\d{1,2}$/', $c[0])) continue;   // 見出しの行など（日付で始まらない行）
    /* 日付の行なのに列の数が違う → ページの形が変わった。飛ばさずに全体を失敗にする */
    if (count($c) !== 21) throw new RuntimeException('日の行の列の数が想定と違います（' . $c[0] . '日）');
    $d = (int)$c[0];
    if ($d < 1 || $d > $last) throw new RuntimeException('日付が想定と違います（' . $c[0] . '）');
    if (isset($days[sprintf('%02d', $d)])) throw new RuntimeException('同じ日が2回あります（' . $d . '日）');
    $rain = num_of($c[3]);
    $days[sprintf('%02d', $d)] = [
      'rain' => $rain === null ? ($c[3] === '--' ? 0 : null) : $rain,
      'wind' => num_of($c[12]), 'windDir' => $c[13] ?? '',
      'gust' => num_of($c[14]), 'gustDir' => $c[15] ?? '',
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
