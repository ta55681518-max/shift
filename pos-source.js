/* ============================================================
   串焼KEMURI屋 売上データの取得層  pos-source.js
   ------------------------------------------------------------
   【この層の役目】
   E-POS（エクストリンクPOS）との繋ぎ方がまだ決まっていないので、
   「売上をどうやって手に入れるか」だけをここに閉じ込める。
   在庫・分析・予測の側は、下の SaleRecord の形しか見ない。

     SaleRecord = {
       key,      … 二重取込よけのキー（※形を変えると既に取り込んだ
                    ぶんをもう一度引いてしまう。絶対に変えないこと）
       at,       … 元の日時文字列（列が無ければ空）
       day,      … 'YYYY-MM-DD'
       ticket,   … 伝票番号（あれば明細形式、無ければ集計形式）
       posName,  … POSの商品名（そのまま）
       qty,      … 売れた数
       amount    … 売上金額（列があれば。無ければ 0）
     }

   【差し替えの順番】
     ① CsvManualSource … 手で取り込む（CSV／貼り付け／取り込みボタン）← いまここ
     ② CsvAutoSource   … 決めた置き場から自動で取ってくる
     ③ ApiPosSource    … E-POS の API が使えるようになったら

   ②③ は fetchSales() の中身を書くだけでよく、
   対応表・二重取込よけ・在庫減算・分析は一切さわらなくて済む。
   ============================================================ */
(function (global) {
  'use strict';

  var C = global.KemuriCore;
  var num = C.num, norm = C.norm, dayOf = C.dayOf;

  /* 画面にそのまま出してよいエラー */
  function userErr(msg) { var e = new Error(msg); e.userMsg = msg; return e; }

  /* ============================================================
     ① 手で取り込む（CSVファイル／貼り付け／取り込みボタン）
     ============================================================ */
  var CsvManualSource = {
    id: 'csv',
    label: 'CSV取込（手動）',
    caps: { manual: true, auto: false, range: false },

    /* 前回の列設定を覚えておくための入口。
       使う側が CsvManualSource.getColMemo = () => DB.csvMap; のように差す */
    getColMemo: function () { return null; },

    /* file -> { file, rows, headIdx, cols } */
    read: async function (file) {
      var text = await decodeFile(file);
      if (text.slice(0, 2) === 'PK') throw userErr('エクセル形式（.xlsx）は取り込めません。POSからCSVで書き出してください');
      return this.fromText(text, file.name);
    },

    /* 貼り付けたテキストからでも同じように読み取る */
    fromText: function (text, name) {
      var rows = parseCSV(text);
      if (!rows.length) throw userErr('中身が読み取れませんでした');
      var headIdx = guessHeadRow(rows), cols;
      if (looksLikeHeader(rows[headIdx])) {
        cols = this.guessCols(rows[headIdx]);
      } else {
        headIdx = -1;                      // 見出し無し（取り込みボタンの「商品名⇥出数」など）
        cols = guessColsNoHeader(rows);
      }
      if (cols.name < 0) throw userErr('商品名の列が見つかりませんでした');
      return { file: name, rows: rows, headIdx: headIdx, cols: cols };
    },

    /* 列マッピングに従って SaleRecord[] を作る */
    toSales: function (parsed, period) {
      var rows = parsed.rows, headIdx = parsed.headIdx, cols = parsed.cols;
      var pf = (period && period.from) || '';
      var out = [], cnt = {};
      for (var i = headIdx + 1; i < rows.length; i++) {
        var r = rows[i];
        var name = String(r[cols.name] == null ? '' : r[cols.name]).trim();
        if (!name) continue;
        if (/^(合計|小計|総計|計|.*合計)$/.test(name)) continue;   // 集計行は無視
        var qty = cols.qty >= 0 ? num(r[cols.qty]) : 1;
        if (!qty) continue;
        var at = cols.at >= 0 ? String(r[cols.at] || '').trim() : '';
        var ticket = cols.ticket >= 0 ? String(r[cols.ticket] || '').trim() : '';
        /* 金額は「あれば拾う」だけ。原価率や売れ筋の分析に使う。
           ※ 下のキーには入れない（既に取り込んだぶんと食い違うため） */
        var amount = (cols.amount != null && cols.amount >= 0) ? num(r[cols.amount]) : 0;
        /* 二重取込よけのキー。伝票番号があればそれを軸に、無ければ日時を軸に。
           同じ内容の行が複数あっても数が合うように連番を付ける。 */
        var day = dayOf(at) || pf;   // 日付列が無い集計CSVは、指定した集計期間の開始日を日付として使う
        var base = ticket ? ('T\u0001' + ticket + '\u0001' + norm(name) + '\u0001' + qty)
                          : ('D\u0001' + at + '\u0001' + norm(name) + '\u0001' + qty);
        cnt[base] = (cnt[base] || 0) + 1;
        out.push({ key: base + '#' + cnt[base], at: at, day: day, ticket: ticket, posName: name, qty: qty, amount: amount });
      }
      return out;
    },

    /* 見出し行から列の当たりを付ける。memo は前回と同じ列構成のときに使う控え */
    guessCols: function (head, memo) {
      var cells = (head || []).map(function (c) { return norm(c); });
      var pick = function (key) {
        for (var i = 0; i < COL_HINT[key].length; i++) {
          var w = COL_HINT[key][i];
          var j = cells.findIndex(function (c) { return c && c.indexOf(norm(w)) >= 0; });
          if (j >= 0) return j;
        }
        return -1;
      };
      var c = { name: pick('name'), qty: pick('qty'), at: pick('at'), ticket: pick('ticket'), amount: pick('amount') };
      if (c.name < 0) c.name = 0;
      /* 金額が他の列と同じところを指したら、拾えなかったものとして扱う */
      if (c.amount >= 0 && (c.amount === c.qty || c.amount === c.name || c.amount === c.at || c.amount === c.ticket)) c.amount = -1;

      /* 前回と同じ列構成なら前回の設定を使う */
      var m = (memo === undefined) ? this.getColMemo() : memo;
      if (m && m.sig === cells.join('|')) {
        var saved = Object.assign({}, m.cols);
        if (saved.amount == null) saved.amount = c.amount;   // 金額列は後から足したので、古い控えには入っていない
        return saved;
      }
      return c;
    },

    /* CSVの「抽出期間：2026-09-01～2026-09-15」から期間を読み取る */
    periodFromRows: function (rows, headIdx) {
      var txt = rows.slice(0, Math.max(headIdx, 1)).map(function (r) { return r.join(' '); }).join(' ');
      var m = txt.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})\D{0,4}?[～~〜](\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
      if (!m) return null;
      var z = function (n) { return ('0' + n).slice(-2); };
      return { from: m[1] + '-' + z(m[2]) + '-' + z(m[3]), to: m[4] + '-' + z(m[5]) + '-' + z(m[6]), auto: true };
    }
  };

  /* ============================================================
     ② CSV自動取得（Phase 3）
     ------------------------------------------------------------
     決めた置き場（GASスプレッドシート等）に貯まったCSVを取ってくる。
     fetchSales() の中で CSV本文を手に入れたら、あとは
       CsvManualSource.toSales(CsvManualSource.fromText(text, 名前), 期間)
     を呼ぶだけで、①とまったく同じ SaleRecord[] になる。
     ============================================================ */
  var CsvAutoSource = {
    id: 'csv-auto',
    label: 'CSV自動取得',
    caps: { manual: false, auto: true, range: true },
    ready: false,
    config: { url: '' },       // 置き場のURL（設定画面から入れる）
    fetchSales: async function (/* { from, to } */) {
      throw userErr('CSV自動取得はまだ準備中です（Phase 3）');
    }
  };

  /* ============================================================
     ③ E-POS API（Phase 4）
     ------------------------------------------------------------
     繋ぎ方が決まったら fetchSales() だけ実装する。
     在庫・分析側は何も変えなくてよい。
     ============================================================ */
  var ApiPosSource = {
    id: 'api',
    label: 'E-POS API',
    caps: { manual: false, auto: true, range: true },
    ready: false,
    config: { endpoint: '', storeId: '' },
    fetchSales: async function (/* { from, to } */) {
      throw userErr('E-POS API連携はまだ準備中です（Phase 4）');
    }
  };

  /* ---------- 取得元の登録と選択 ---------- */
  var SRC_KEY = 'kemuri_pos_source';
  var sources = [CsvManualSource, CsvAutoSource, ApiPosSource];

  var KemuriPos = {
    userErr: userErr,
    CsvManualSource: CsvManualSource,
    CsvAutoSource: CsvAutoSource,
    ApiPosSource: ApiPosSource,

    list: function () { return sources.slice(); },
    /* 使えるものだけ（準備中のものは出さない） */
    available: function () { return sources.filter(function (s) { return s.ready !== false; }); },
    register: function (src) {
      sources = sources.filter(function (s) { return s.id !== src.id; }).concat([src]);
      return src;
    },
    get: function (id) {
      for (var i = 0; i < sources.length; i++) if (sources[i].id === id) return sources[i];
      return null;
    },
    /* いま選ばれている取得元。未設定・準備中なら手動CSVに戻す */
    current: function () {
      var id = '';
      try { id = global.localStorage.getItem(SRC_KEY) || ''; } catch (e) {}
      var s = this.get(id);
      return (s && s.ready !== false) ? s : CsvManualSource;
    },
    setCurrent: function (id) {
      var s = this.get(id);
      if (!s || s.ready === false) return false;
      try { global.localStorage.setItem(SRC_KEY, s.id); } catch (e) {}
      return true;
    },

    /* 中身が要るときのために外にも出しておく */
    decodeFile: decodeFile,
    parseCSV: parseCSV,
    guessHeadRow: guessHeadRow,
    looksLikeHeader: looksLikeHeader,
    guessColsNoHeader: guessColsNoHeader,
    COL_HINT: null   // 下で入れる
  };

  /* ============================================================
     ここから下は CSV を読むための道具（①が使う）
     ============================================================ */

  /* 文字コード自動判定（UTF-8 / BOM / Shift_JIS） */
  async function decodeFile(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var b = buf;
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    else if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    else if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) {}
    try { return new TextDecoder('shift_jis').decode(b); } catch (e) {}
    return new TextDecoder().decode(b);
  }

  /* 区切り文字を推測してCSV/TSVを行列に */
  function parseCSV(text) {
    var head = text.slice(0, 3000);
    var d = (head.split('\t').length > head.split(',').length) ? '\t' : ',';
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === d) { row.push(cur); cur = ''; }
        else if (c === '\r') {}
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += c;
      }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  /* ヘッダー行らしい行を探す（タイトル行が上にあるPOS出力にも対応） */
  /* 見出し行を当てる。
     エクストリンクPOSの書き出しは、本当の見出しの上に
       ソート:,金額順.
       時間:,～.
     のような行が入る。「金額順.」にも「金額」が入っているので、
     «最初に見つかった行» を見出しにすると、ここを掴んでしまって
     商品名も出数も読めなくなる。
     そこで «見出しらしい語がいくつ当たったか» で点数を付けて選ぶ。 */
  function guessHeadRow(rows) {
    var kw = /(商品|品名|メニュー|品目|数量|個数|点数|出数|販売数|日付|日時|伝票|単価|金額|売上)/;
    var lim = Math.min(rows.length, 12);
    var best = 0, bestHit = -1, bestN = 0;
    for (var i = 0; i < lim; i++) {
      var f = rows[i].filter(function (c) { return String(c).trim() !== ''; });
      if (f.length < 2) continue;
      var hit = f.filter(function (c) { return kw.test(String(c)); }).length;
      /* 当たった数が多いほう。同じなら列が多いほう。それも同じなら上の行 */
      if (hit > bestHit || (hit === bestHit && f.length > bestN)) {
        best = i; bestHit = hit; bestN = f.length;
      }
    }
    if (bestHit > 0) return best;
    /* 見出しらしい語が1つも無い＝いちばん列の多い行 */
    var b2 = 0, bn = 0;
    for (var j = 0; j < lim; j++) {
      var n = rows[j].filter(function (c) { return String(c).trim() !== ''; }).length;
      if (n > bn) { bn = n; b2 = j; }
    }
    return b2;
  }

  function looksLikeHeader(row) {
    return /(商品|品名|メニュー|品目|数量|個数|点数|出数|日付|日時|伝票|単価|金額)/.test((row || []).join(' '));
  }

  /* 見出しが無い貼り付け（商品名と出数だけ）から、商品名と出数の列を見つける。
     「538円」「7.8%」「104,550円」は出数ではないので、裸の整数だけを出数とみなす。 */
  function guessColsNoHeader(rows) {
    var isInt = function (v) {
      var t = String(v == null ? '' : v).trim();
      return !/[円%¥￥.]/.test(t) && /^\d{1,7}$/.test(t.replace(/[,\s]/g, ''));
    };
    var isName = function (v) {
      var t = String(v == null ? '' : v).trim();
      return !!t && !/^[A-EＡ-Ｅ]$/.test(t) && /[^\d,.\s円%¥￥\-]/.test(t);
    };
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var r = rows[i];
      var n = -1;
      for (var j = 0; j < r.length; j++) { if (isName(r[j])) { n = j; break; } }
      if (n < 0) continue;
      for (var k = n + 1; k < r.length; k++) { if (isInt(r[k])) return { name: n, qty: k, at: -1, ticket: -1, amount: -1 }; }
    }
    return { name: 0, qty: 1, at: -1, ticket: -1, amount: -1 };
  }

  var COL_HINT = {
    name  : ['商品名', 'メニュー名', '品名', '商品', '品目', 'メニュー', 'アイテム', 'item', 'name'],
    qty   : ['出数', '販売数', '売上数', '数量', '個数', '点数', '数', 'qty', 'quantity'],
    at    : ['会計日時', '売上日時', '日時', '伝票日付', '売上日', '営業日', '日付', '年月日', 'date'],
    ticket: ['伝票番号', '伝票no', '伝票ｎｏ', 'レシート番号', '取引番号', '会計番号', '注文番号', '伝票', 'receipt'],
    /* 金額は後から足した項目。「平均単価」を拾わないよう、具体的な語を先に並べる */
    amount: ['売上金額', '販売金額', '合計金額', '税抜金額', '税込金額', '金額', 'amount']
  };
  KemuriPos.COL_HINT = COL_HINT;

  global.KemuriPos = KemuriPos;
})(typeof window !== 'undefined' ? window : this);
