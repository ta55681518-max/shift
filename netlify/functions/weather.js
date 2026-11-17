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

/* 文字の部分（タグの外）の後始末：よく出る記号を戻し、空白をつめる */
function clean(t) {
  return String(t).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------
   HTML を頭から順に読み、«本物のタグ» «文字» を区別して並べる（Codex指摘26）。
   ・コメント（<!-- -->）の中は読まない。閉じていないコメントは «読めない» の印を付ける
   ・タグの設定値（引用符の中）は設定値として読む。中に <tr> などの文字があってもタグにしない
   ・script / style / textarea / title / template / noscript などの中身は読み飛ばす（画面に表として出ない部分。中のタグ文字はタグにしない）
   ・途中で終わったタグ・閉じていない引用符は «読めない» の印（bad）にする
   返り値：[{ t:'open', name, attrs, self } | { t:'close', name } | { t:'text', s } | { t:'bad', why }]
   ------------------------------------------------------------ */
const RAW = { script: 1, style: 1, textarea: 1, title: 1, template: 1, noscript: 1, iframe: 1, noembed: 1, noframes: 1, xmp: 1 };
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
function isSpace(c) { return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f'; }
function tokenize(html) {
  const h = String(html), n = h.length, out = [];
  let i = 0, textFrom = 0;
  const flush = function (to) { if (to > textFrom) out.push({ t: 'text', s: h.slice(textFrom, to) }); };
  while (i < n) {
    if (h[i] !== '<') { i++; continue; }
    const c = h[i + 1];
    if (h.startsWith('<!--', i)) {                                   // コメント
      flush(i);
      const e = h.indexOf('-->', i + 4);
      if (e < 0) { out.push({ t: 'bad', why: 'コメントが閉じていません' }); return out; }
      i = e + 3; textFrom = i; continue;
    }
    if (c === '!' || c === '?') {                                    // <!DOCTYPE ...> など
      flush(i);
      const e = h.indexOf('>', i);
      if (e < 0) { out.push({ t: 'bad', why: '宣言が閉じていません' }); return out; }
      i = e + 1; textFrom = i; continue;
    }
    if (c === '/') {                                                 // 閉じタグ
      if (!(i + 2 < n) || !isAlpha(h[i + 2])) {                      // </ のあとが文字でない：ブラウザはコメント扱いにする
        flush(i);
        const e = h.indexOf('>', i);
        if (e < 0) { out.push({ t: 'bad', why: 'タグが閉じていません' }); return out; }
        i = e + 1; textFrom = i; continue;
      }
      flush(i);
      let j = i + 2;
      while (j < n && !isSpace(h[j]) && h[j] !== '>' && h[j] !== '/') j++;
      const name = h.slice(i + 2, j).toLowerCase();
      const e = h.indexOf('>', j);
      if (e < 0) { out.push({ t: 'bad', why: '閉じタグが途中で終わっています' }); return out; }
      /* 閉じタグに余計なもの（設定値など）が付いていたら、形が想定外として印を付ける */
      if (h.slice(j, e).trim() !== '') out.push({ t: 'bad', why: '閉じタグの形が想定と違います（' + name + '）' });
      out.push({ t: 'close', name: name });
      i = e + 1; textFrom = i; continue;
    }
    if (!c || !isAlpha(c)) { i++; continue; }                        // ただの «<» の文字
    /* 開始タグ */
    flush(i);
    let j = i + 1;
    while (j < n && !isSpace(h[j]) && h[j] !== '>' && h[j] !== '/') j++;
    const name = h.slice(i + 1, j).toLowerCase();
    const attrs = {};
    let self = false, closed = false;
    while (j < n) {
      while (j < n && isSpace(h[j])) j++;
      if (j >= n) break;
      if (h[j] === '>') { j++; closed = true; break; }
      if (h[j] === '/') { if (h[j + 1] === '>') { self = true; j += 2; closed = true; break; } j++; continue; }
      let a = j;
      while (j < n && !isSpace(h[j]) && h[j] !== '=' && h[j] !== '>' && h[j] !== '/') j++;
      if (j === a) { j++; continue; }                                // 先頭が «=» の設定名など
      const an = h.slice(a, j).toLowerCase();
      let av = '';
      while (j < n && isSpace(h[j])) j++;
      if (h[j] === '=') {
        j++;
        while (j < n && isSpace(h[j])) j++;
        if (h[j] === '"' || h[j] === "'") {
          const q = h[j], e = h.indexOf(q, j + 1);
          if (e < 0) { out.push({ t: 'bad', why: '設定値の引用符が閉じていません' }); return out; }
          av = h.slice(j + 1, e); j = e + 1;
        } else {
          a = j;
          while (j < n && !isSpace(h[j]) && h[j] !== '>') j++;
          av = h.slice(a, j);
        }
      }
      if (!Object.prototype.hasOwnProperty.call(attrs, an)) attrs[an] = av;   // 同じ名前は最初のものが有効
    }
    if (!closed) { out.push({ t: 'bad', why: 'タグが途中で終わっています' }); return out; }
    out.push({ t: 'open', name: name, attrs: attrs, self: self });
    i = j; textFrom = i;
    if (RAW[name] && !self) {                                        // 中身は文字として読み飛ばす
      const re = new RegExp('</' + name + '[\\s>/]', 'i');
      const rest = h.slice(i), mm = re.exec(rest);
      if (!mm) { out.push({ t: 'bad', why: name + ' が閉じていません' }); return out; }
      i += mm.index; textFrom = i;                                   // 中身は捨てる（文字としても使わない）
    }
  }
  flush(n);
  return out;
}

/* 気象庁の表の数値：「3.5」「3.5)」「0.0]」→ 数値。「--」（現象なし）「///」「×」「#」や空 → null */
function numOf(s) {
  const m = String(s).match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/* 表の中で、行の外に置いてよいタグ（行のまとまり・列の指定など） */
const TABLE_PARTS = { tbody: 1, thead: 1, tfoot: 1, caption: 1, colgroup: 1, col: 1 };

/* ページのHTML → { days: { '01': {...} }, count } 。形が違えば throw
   方針：推測で埋めない。読めない形・想定と違う形は、1か所でも全体を失敗にする */
function parse(html, ym, whole) {
  const toks = tokenize(html);
  /* 1) コメントや設定値の外にある «本物の» 表のうち、id が tablefix1 のものを選ぶ */
  const starts = [];
  toks.forEach(function (k, i) { if (k.t === 'open' && k.name === 'table' && k.attrs.id === 'tablefix1') starts.push(i); });
  if (!starts.length) throw new Error('表が見つかりません');
  if (starts.length > 1) throw new Error('同じ名前の表が2つ以上あります');
  if (toks[starts[0]].self) throw new Error('表の形が想定と違います');

  /* 2) 表の終わりまで、行・セルの対応と入れ子を確かめながら読む */
  const rows = [];
  let row = null, cell = null, ended = false;
  for (let i = starts[0] + 1; i < toks.length; i++) {
    const k = toks[i];
    if (k.t === 'bad') throw new Error('表の途中に読めない部分があります（' + k.why + '）');
    if (k.t === 'text') { if (cell) cell.text += k.s; continue; }
    const nm = k.name;
    if (k.t === 'open') {
      if (nm === 'table') throw new Error('表の中に別の表があります');
      if (nm === 'tr') {
        if (row || cell || k.self) throw new Error('表の行のタグが対応していません');
        row = { td: [], th: 0 };
      } else if (nm === 'td' || nm === 'th') {
        if (!row || cell || k.self) throw new Error('表のセルのタグが対応していません');
        cell = { kind: nm, text: '' };
      } else if (TABLE_PARTS[nm]) {
        if (row || cell) throw new Error('表の行の中に、行のまとまりのタグがあります');
      } else if (!cell && RAW[nm]) {
        throw new Error('表の中に想定外のタグがあります（' + nm + '）');
      }
      /* そのほかのタグ（a・div・span・br・img など）は、セルの中の飾りとして読み飛ばす（文字は拾う） */
      continue;
    }
    /* 閉じタグ */
    if (nm === 'table') {
      if (row || cell) throw new Error('表が、行やセルの途中で終わっています');
      ended = true; break;
    }
    if (nm === 'tr') {
      if (!row || cell) throw new Error('表の行のタグが対応していません');
      rows.push(row); row = null;
    } else if (nm === 'td' || nm === 'th') {
      if (!cell || cell.kind !== nm) throw new Error('表のセルのタグが対応していません');
      if (nm === 'td') row.td.push(clean(cell.text)); else { row.th++; row.heads = (row.heads || []).concat(clean(cell.text)); }
      cell = null;
    } else if (TABLE_PARTS[nm]) {
      if (row || cell) throw new Error('表の行の中に、行のまとまりのタグがあります');
    }
  }
  if (!ended) throw new Error('表が閉じていません');

  /* 3) 見出し（本物の見出しセルの文字だけで確かめる）：あること・左からの並び */
  const heads = [];
  rows.forEach(function (r) { (r.heads || []).forEach(function (t) { heads.push(t); }); });
  const at = function (w) { for (let i = 0; i < heads.length; i++) if (heads[i].indexOf(w) >= 0) return i; return -1; };
  const iR = at('降水量'), iW = at('風向・風速'), iG = at('天気概況');
  if (iR < 0 || iG < 0 || at('最大瞬間風速') < 0) throw new Error('表の見出しが想定と違います');
  if (!(iR < iW && iW < iG)) throw new Error('表の見出しの並びが想定と違います');

  /* 4) 行の検査。見出しとして飛ばしてよいのは «td が1つも無い行» だけ。
        td のある行はすべて観測の行とみなし、形が想定と違えば全体を失敗にする */
  const y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const days = {};
  let count = 0;
  rows.forEach(function (r) {
    const cells = r.td;
    if (!cells.length) return;
    if (r.th) throw new Error('日の行に見出しのセルが混ざっています');
    if (!/^\d{1,2}$/.test(cells[0])) throw new Error('日付のセルが想定と違います（' + cells[0].slice(0, 10) + '）');
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
exports._tokenize = tokenize;
exports._jstYm = jstYm;
