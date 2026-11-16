/* ============================================================
   串焼KEMURI屋 那覇の過去の天気（サーバー側）  /api/weather?ym=2025-10
   ------------------------------------------------------------
   売上カレンダーに、その日の天気・雨・風を出すための窓口。
   気象庁ホームページ「過去の気象データ検索」の、那覇・日ごとの値（1か月＝1ページ）を
   読み、日ごとの «雨の合計・最大風速・最大瞬間風速・天気概況（昼／夜）» だけを取り出して返す。

   【守ること】
   ・地点は那覇に固定。受け取るのは年月（YYYY-MM）だけ。ほかの宛先へは取りにいかない
   ・気象庁への負荷を小さくする：過ぎた月は長く使い回す（CDN と、この実行環境の中の控え）。
     同じ月を何度開いても、気象庁へ取りにいくのは基本的に1回。今月ぶんだけ数時間おき
   ・キーや合言葉は使わない（公開されている数値を読むだけ）。保存もしない
   ・ページの形が変わっていたら、推測で埋めずに «読めませんでした» を返す

   【出典】気象庁ホームページ（過去の気象データ検索）。数値は加工して表示する
     （利用条件：出典の明記・加工した旨の明記。商用利用可）
   ============================================================ */
'use strict';

const STATION = { name: '那覇', prec_no: '91', block_no: '47936' };
const SOURCE = '気象庁ホームページ（過去の気象データ検索・那覇）';
const BASE = 'https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php';
const MIN_YEAR = 2022;
const TIMEOUT_MS = 9000;
const RATE_MAX = 30, RATE_WINDOW_MS = 60 * 1000;

const memo = new Map();   // この実行環境の中の控え { ym: { at, body } }
const hits = [];
function rateLimited() {
  const now = Date.now();
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  return false;
}

/* 日本時間の «今の年月» */
function jstYm(now) {
  const t = new Date((now || Date.now()) + 9 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0');
}

function text(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
/* 気象庁の表の数値：「3.5」「3.5)」「0.0]」→ 数値。「--」（現象なし）「///」「×」「#」や空 → null */
function numOf(s) {
  const m = String(s).match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/* ページのHTML → { days: { '01': {...} }, count } 。形が違えば throw */
function parse(html, ym, whole) {
  const m = String(html).match(/<table[^>]*id=["']tablefix1["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!m) throw new Error('表が見つかりません');
  const body = m[1];
  if (!/天気概況/.test(body) || !/最大瞬間風速/.test(body) || !/降水量/.test(body)) throw new Error('表の見出しが想定と違います');
  /* 見出しの並び（左から 降水量 → 風向・風速 → 天気概況）も確かめる */
  const iR = body.indexOf('降水量'), iW = body.indexOf('風向・風速'), iG = body.indexOf('天気概況');
  if (!(iR < iW && iW < iG)) throw new Error('表の見出しの並びが想定と違います');
  const y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const days = {};
  let count = 0;
  const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  rows.forEach(function (tr) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(text);
    if (!cells.length || !/^\d{1,2}$/.test(cells[0])) return;   // 見出しの行など（日付で始まらない行）
    /* 指摘26：日付の行なのに列の数が違う → ページの形が変わった。飛ばさずに全体を失敗にする */
    if (cells.length !== 21) throw new Error('日の行の列の数が想定と違います（' + cells[0] + '日）');
    const d = +cells[0];
    if (d < 1 || d > last) throw new Error('日付が想定と違います（' + cells[0] + '）');
    if (days[String(d).padStart(2, '0')]) throw new Error('同じ日が2回あります（' + d + '日）');
    const rain = numOf(cells[3]);
    days[String(d).padStart(2, '0')] = {
      rain: rain == null ? (cells[3] === '--' ? 0 : null) : rain,   // 「--」は雨なし
      wind: numOf(cells[12]), windDir: cells[13] || '',
      gust: numOf(cells[14]), gustDir: cells[15] || '',
      day: /^[-/×#\s]*$/.test(cells[19]) ? '' : cells[19],
      night: /^[-/×#\s]*$/.test(cells[20]) ? '' : cells[20],
    };
    count++;
  });
  if (!count) throw new Error('日ごとの行が読めません');
  /* 1日から続いていること。過ぎた月（whole）は、月の日数ぶんそろっていること */
  for (let i = 1; i <= count; i++) if (!days[String(i).padStart(2, '0')]) throw new Error('日が抜けています（' + i + '日）');
  if (whole && count !== last) throw new Error('月の日数ぶんそろっていません（' + count + '/' + last + '日）');
  return { days: days, count: count };
}

function respond(status, obj, cache) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache || 'no-store' };
  if (cache && cache !== 'no-store') h['Netlify-CDN-Cache-Control'] = cache;
  return { statusCode: status, headers: h, body: JSON.stringify(obj) };
}

async function handler(event) {
  if (event.httpMethod !== 'GET') return respond(405, { ok: false, why: 'GET だけ受け付けます' });
  const ym = String((event.queryStringParameters || {}).ym || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return respond(400, { ok: false, why: '年月（YYYY-MM）を指定してください' });
  const nowYm = jstYm();
  if (+ym.slice(0, 4) < MIN_YEAR || ym > nowYm) return respond(400, { ok: false, why: 'その年月は対象外です' });

  const past = ym < nowYm;
  /* 過ぎた月：30日使い回す。今月：3時間 */
  const cache = past ? 'public, max-age=86400, s-maxage=2592000' : 'public, max-age=3600, s-maxage=10800';
  const ttl = past ? 30 * 86400 * 1000 : 3 * 3600 * 1000;
  const hit = memo.get(ym);
  if (hit && Date.now() - hit.at < ttl) return respond(200, hit.body, cache);

  if (rateLimited()) return respond(429, { ok: false, why: '少し時間をおいてから開いてください' });

  const url = BASE + '?prec_no=' + STATION.prec_no + '&block_no=' + STATION.block_no
            + '&year=' + (+ym.slice(0, 4)) + '&month=' + (+ym.slice(5, 7)) + '&day=&view=';
  const ac = new AbortController();
  const timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'KEMURIya-sales-calendar/1.0 (low-frequency; monthly page; cached)' } });
    if (!res.ok) return respond(502, { ok: false, why: '気象庁のページを開けませんでした（' + res.status + '）' });
    const html = await res.text();
    const p = parse(html, ym, past);
    const body = { ok: true, ym: ym, station: STATION.name, source: SOURCE, edited: true, count: p.count, days: p.days };
    memo.set(ym, { at: Date.now(), body: body });
    if (memo.size > 60) memo.delete(memo.keys().next().value);
    return respond(200, body, cache);
  } catch (e) {
    return respond(502, { ok: false, why: '気象庁のページを読めませんでした（' + String((e && e.message) || e).slice(0, 80) + '）' });
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = handler;
exports._parse = parse;
exports._jstYm = jstYm;
