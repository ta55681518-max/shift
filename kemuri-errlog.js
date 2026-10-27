/* ============================================================
   串焼KEMURI屋  保存エラーの記録  kemuri-errlog.js
   ------------------------------------------------------------
   段階0・残課題A-1（test-envのみ）。

   なぜ要るか
   ・IndexedDB の保存に失敗したとき、これまでの試験ページは
     «エラー null» としか出せなかった。トランザクションの error は
     失敗した瞬間にはまだ null で、本当の理由は «書き込み要求» の側
     （event.target.error）にあるため。
   ・ここでは «書き込み要求 → トランザクション → 開くとき» の順に
     必ず理由を拾い、拾えなかったときも «どの段階で、拾えなかったか»
     を残す。

   守ること
   ・記録は保存処理の «外»。失敗しても例外を出さない。保存の結果を変えない。
   ・記録先は localStorage の別キー（テスト：kmtest_errlog）。
     IndexedDB の同じトランザクションには入れない（中止されると記録も消えるため）。
     バックアップの対象（KemuriBackup.KEYS）にも入らない。
   ・入れるのは決めた項目だけ。データの中身・画像・ファイル名・仕入先名・
     人名・UserAgent全体は入れない。
   ・最新50件・合計20,000文字まで。古いものから捨てる。
   ============================================================ */
(function (global) {
  'use strict';

  var TEST = global.KEMURI_ENV === 'test';
  var KEY = TEST ? 'kmtest_errlog' : 'kemuri_errlog_v1';
  var MAX_N = 50, MAX_CH = 20000;
  var mem = [];                         /* 書けなかったときの控え（この画面の中だけ） */
  var ENV = { persisted: null, quotaMB: null };

  /* ---------- 中身を入れないための整形 ---------- */
  function word(v, n) {                 /* 決まった名前（処理名・段階など）だけ通す */
    if (v == null) return '';
    return String(v).replace(/[^A-Za-z0-9_.:\-]/g, '').slice(0, n || 40);
  }
  function msg(v) {                     /* エラーの文。改行を消し、200文字まで */
    if (v == null) return '';
    return String(v).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  }
  function mime(v) {                    /* 種類名だけ（image/jpeg など）。ファイル名は通さない */
    v = String(v || '').toLowerCase();
    return /^[a-z]+\/[a-z0-9.+\-]{1,40}$/.test(v) ? v : '';
  }
  function bucket(n) {                  /* 大きさは区分だけ */
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n <= 1048576) return '<=1MB';
    if (n <= 5 * 1048576) return '<=5MB';
    return '>5MB';
  }
  function iosVer() {
    try {
      var m = String(global.navigator.userAgent || '').match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
      return m ? m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '') : '';
    } catch (e) { return ''; }
  }
  function standalone() {
    try {
      return (global.navigator.standalone === true) ||
        !!(global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);
    } catch (e) { return false; }
  }
  function ls() { try { return global.localStorage; } catch (e) { return null; } }

  /* ---------- エラーを決まった形にする ----------
     err … DOMException・Error・IdbFail・null のどれでもよい
     ctx … { op, step, src, store, kind, size, type, aborted, note }（決めた項目だけ使う） */
  function describe(err, ctx) {
    ctx = ctx || {};
    var e = err;
    if (e && e.kemuriIdb) {             /* すでにまとめたもの（IdbFail）はそのまま使う */
      return {
        at: new Date().toISOString(),
        op: word(ctx.op || e.op), step: word(ctx.step || e.step, 20), src: word(e.src, 20),
        name: word(e.name, 60), message: msg(e.message), code: typeof e.code === 'number' ? e.code : null,
        store: word(ctx.store || e.store), kind: word(ctx.kind || e.kind, 20),
        size: bucket(ctx.size != null ? ctx.size : e.sizeN), type: mime(ctx.type || e.type),
        aborted: !!(ctx.aborted || e.aborted), note: word(ctx.note || e.note, 60)
      };
    }
    var has = e != null && e !== '';
    return {
      at: new Date().toISOString(),
      op: word(ctx.op), step: word(ctx.step, 20),
      src: has ? word(ctx.src || 'thrown', 20) : 'none',
      name: has ? word(e.name || (typeof e === 'string' ? 'Error' : ''), 60) : '',
      message: has ? msg(e.message != null ? e.message : e) : '',
      code: has && typeof e.code === 'number' ? e.code : null,
      store: word(ctx.store), kind: word(ctx.kind, 20), size: bucket(ctx.size), type: mime(ctx.type),
      aborted: !!ctx.aborted, note: word(ctx.note, 60)
    };
  }

  /* ---------- 記録（失敗しても投げない） ---------- */
  function record(entry) {
    var x;
    try {
      x = entry && entry.at ? entry : describe(null, entry);
      x.env = TEST ? 'test' : 'prod';
      x.standalone = standalone();
      x.ios = iosVer();
      x.persisted = ENV.persisted;
      x.quotaMB = ENV.quotaMB;
    } catch (e) { return null; }
    try { mem.push(x); if (mem.length > MAX_N) mem.splice(0, mem.length - MAX_N); } catch (e) {}
    try {
      var s = ls(); if (!s) return x;
      var arr = [];
      try { arr = JSON.parse(s.getItem(KEY) || '[]'); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
      arr.push(x);
      if (arr.length > MAX_N) arr = arr.slice(arr.length - MAX_N);
      var t = JSON.stringify(arr);
      while (t.length > MAX_CH && arr.length > 1) { arr.shift(); t = JSON.stringify(arr); }
      s.setItem(KEY, t);
    } catch (e) { /* 書けなくても保存処理には影響させない。mem に残っている */ }
    return x;
  }
  function fromError(err, ctx) {
    try { return record(describe(err, ctx)); } catch (e) { return null; }
  }
  function list() {
    try {
      var s = ls(); var arr = JSON.parse((s && s.getItem(KEY)) || '[]');
      if (Array.isArray(arr) && arr.length >= mem.length) return arr;
    } catch (e) {}
    return mem.slice();
  }
  function clear() { mem = []; try { var s = ls(); if (s) s.removeItem(KEY); } catch (e) {} }

  /* 人が読む一行（null・空欄にならないように） */
  function format(x) {
    if (!x) return '理由不明（記録できませんでした）';
    if (!x.at) x = describe(x, {});
    var head = x.name ? x.name : (x.src === 'none' ? '理由不明（ブラウザがエラーを返しませんでした）' : '名前なし');
    var parts = [head];
    if (x.message) parts.push(x.message);
    if (x.code != null) parts.push('code ' + x.code);
    parts.push('段階 ' + (x.step || '-') + '／取れた場所 ' + (x.src || '-'));
    if (x.op) parts.push('処理 ' + x.op);
    if (x.note) parts.push(x.note);
    return parts.join('／');
  }
  function text() {
    return list().map(function (x) {
      return x.at + ' ' + format(x) + (x.kind ? '／' + x.kind : '') + (x.size ? ' ' + x.size : '') +
        (x.type ? ' ' + x.type : '') + '／iOS ' + (x.ios || '-') + (x.standalone ? '・ホーム画面' : '・タブ') +
        '／persisted ' + x.persisted + '／見積 ' + (x.quotaMB == null ? '-' : x.quotaMB + 'MB');
    }).join('\n');
  }

  /* 記録に添える «いまの保存の状態»（持ち回り。記録のたびには聞かない） */
  function refreshEnv() {
    var st = global.navigator && global.navigator.storage;
    var p1 = st && st.persisted ? st.persisted().then(function (v) { ENV.persisted = !!v; }, function () {}) : Promise.resolve();
    var p2 = st && st.estimate ? st.estimate().then(function (e) { ENV.quotaMB = Math.round((e.quota || 0) / 1048576); }, function () {}) : Promise.resolve();
    return Promise.all([p1, p2]).then(function () { return { persisted: ENV.persisted, quotaMB: ENV.quotaMB }; });
  }

  /* ---------- IndexedDB を «理由を拾える形» で待つ ---------- */
  function IdbFail(err, info) {
    this.kemuriIdb = true;
    var has = err != null;
    this.name = has ? String(err.name || 'Error') : '';
    this.message = has ? String(err.message != null ? err.message : err) : '';
    this.code = has && typeof err.code === 'number' ? err.code : null;
    this.op = info.op || ''; this.step = info.step || ''; this.store = info.store || '';
    this.src = has ? (info.src || 'request') : 'none';
    this.aborted = !!info.aborted; this.note = info.note || '';
    this.kind = info.kind || ''; this.sizeN = info.size; this.type = info.type || '';
  }
  IdbFail.prototype.toString = function () { return format(describe(this, {})); };

  function storeName(t) { try { return t && t.source && t.source.name ? t.source.name : ''; } catch (e) { return ''; } }

  /* 書き込み要求1つを待つ */
  function idbReq(req, op) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function (ev) {
        var e = null;
        try { e = (ev && ev.target && ev.target.error) || req.error; } catch (x) {}
        rej(new IdbFail(e, { op: op, step: 'request', src: 'request', store: storeName(req) }));
      };
    });
  }
  /* トランザクションの終わりを待つ。
     失敗の理由は «最初に失敗した書き込み要求» を優先し、無ければ tx.error。
     error のあとは必ず abort が来るので、abort で決着をつける（null で返さない）。 */
  function idbTx(tx, op, info) {
    info = info || {};
    return new Promise(function (res, rej) {
      var first = null;
      try {
        tx.addEventListener('error', function (ev) {
          if (first) return;
          var t = ev && ev.target, e = null;
          try { e = t && t.error; } catch (x) {}
          if (e) first = { e: e, src: t === tx ? 'transaction' : 'request', store: storeName(t) };
        });
      } catch (x) {}
      tx.oncomplete = function () { res(true); };
      tx.onabort = function () {
        var e = first ? first.e : null, src = first ? first.src : '';
        if (!e) { try { e = tx.error; } catch (x) {} if (e) src = 'transaction'; }
        rej(new IdbFail(e, {
          op: op, step: 'abort', src: src, aborted: true, store: (first && first.store) || '',
          note: e ? '' : 'abort-without-error', kind: info.kind, size: info.size, type: info.type
        }));
      };
    });
  }
  /* 開く。ver を省くと今の版で開く。接続が切れたとき（iPhoneで裏に回したあと等）も記録する */
  function idbOpen(name, ver, up, op) {
    return new Promise(function (res, rej) {
      var r;
      try { r = ver ? global.indexedDB.open(name, ver) : global.indexedDB.open(name); }
      catch (e) { rej(new IdbFail(e, { op: op, step: 'open', src: 'thrown' })); return; }
      r.onupgradeneeded = function () { if (up) up(r.result, r); };
      r.onsuccess = function () {
        var db = r.result;
        try {
          db.onclose = function () { fromError(null, { op: op, step: 'close', note: 'connection-closed' }); };
          db.onversionchange = function () { try { db.close(); } catch (e) {} fromError(null, { op: op, step: 'versionchange', note: 'closed-for-versionchange' }); };
        } catch (e) {}
        res(db);
      };
      r.onerror = function (ev) {
        var e = null; try { e = r.error || (ev && ev.target && ev.target.error); } catch (x) {}
        rej(new IdbFail(e, { op: op, step: 'open', src: 'open' }));
      };
      r.onblocked = function () { rej(new IdbFail(null, { op: op, step: 'open', note: 'blocked' })); };
    });
  }

  /* 画面の全体で拾えなかった失敗も記録する（試験ページ用） */
  var installed = false;
  function installGlobal() {
    if (installed) return; installed = true;
    try {
      global.addEventListener('unhandledrejection', function (ev) {
        fromError(ev && ev.reason, { op: 'unhandled', step: 'promise', src: 'unhandled' });
      });
    } catch (e) {}
  }

  global.KemuriErr = {
    KEY: KEY,
    describe: describe, record: record, fromError: fromError,
    list: list, clear: clear, format: format, text: text,
    refreshEnv: refreshEnv, installGlobal: installGlobal,
    idbReq: idbReq, idbTx: idbTx, idbOpen: idbOpen, IdbFail: IdbFail,
    _bucket: bucket, _iosVer: iosVer
  };
})(typeof window !== 'undefined' ? window : this);
