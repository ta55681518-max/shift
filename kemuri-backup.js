/* ============================================================
   串焼KEMURI屋  まるごとバックアップ  kemuri-backup.js
   ------------------------------------------------------------
   データはこの端末のブラウザの中（localStorage）にしかない。
   しかも «ブラウザ × URL» ごとに別で、iPhoneでホーム画面に追加した
   アプリは Safari とも Chrome とも別の入れ物になる。
   つまり、そこが消えたら 268日ぶんの売上も仕入原価も戻せない。

   冷凍在庫アプリの「今のデータを書き出す」は在庫アプリのぶんだけで、
   売上履歴・原価・レシピは含まれていなかった。ここでは関係する
   キーを «まとめて» 書き出し／読み込みする。

   ・中身はそのまま持っていく（解釈しない）。読める形なら JSON として、
     読めなければ文字列のまま包む。どちらか分かるように印をつける。
   ・AIの返事の控え（kemuri_ai_cache_v1）は入れない。作り直せるし、
     入れると重くなるだけなので。

   第2形式（v:2・段階0で追加。test-envのみ）
   ・書き出すときに、キーごとの検査値（hash）・文字数（len）・件数（count）を付ける
     → 読み込むとき、途中で切れた・書きかわったファイルを見分けられる
   ・どこで作ったか（env：test／prod、host）を付ける
   ・idb … 端末の IndexedDB に置く明細（納品書の明細など）の入れ場所。
     いまは使っていない（空）。統合のときにここへ入れる
   ・第1形式（v:1）のファイルもそのまま読める（検査値が無いので形だけ確かめる）

   安全な復元（applySafe・段階0：第2-B・E7）
   ・呼ぶ側が編集権（鍵 kemuri-reitou-editor）を持っている間だけ使う。戻り値は Promise
   ・① 置きかえる前の中身（控え）を IndexedDB（kemuri-safety）に書き、読み直して完全に
       一致することを確かめてから、localStorage に小さな «復元中の印»（kemuri_restore_v1・v:2）
       を書く。控えを localStorage に置かないので、復元に要る容量が «データの約2倍» から
       «約1倍» になる（iPhone の localStorage は約5MB しかない）
       → IndexedDB が使えないときだけ、これまでどおり印の中に控えを入れる（v:1）。
         それも書けなければ（容量不足など）何も変えずにやめる
     ② キーを1つずつ書いて、読み直して一致を確かめる
     ③ どれか1つでも失敗したら、書いたぶんを控えから元に戻す（巻き戻し）
     ④ 全部入ったら印を消す
   ・途中で画面が落ちた（iPhoneが画面を捨てた等）ときは印が残る。
     次に開いたとき、各アプリは印を見つけて編集を止め、
     «復元前に戻す» かを人に選んでもらう（自動では戻さない）
   ============================================================ */
(function (global) {
  'use strict';

  /* 持っていくもの。増えたらここに足す */
  var KEYS = [
    'kemuri_reitou_v1',     /* 冷凍在庫（品目・在庫・取込履歴・POS対応表） */
    'kemuri_sales_v1',      /* 商品別の売上履歴 */
    'kemuri_daily_v1',      /* 日別売上 */
    'kemuri_costs_v1',      /* 仕入原価 */
    'kemuri_recipes_v1',    /* レシピ */
    'kemuri_zaiko_v1',      /* 串打ち前の在庫 */
    'kemuri_kushiyaki_v1',  /* 串焼き */
    'kemuri_hacchu_v1'      /* 発注 */
  ];
  var LABEL = {
    kemuri_reitou_v1:'在庫アプリ', kemuri_sales_v1:'売上履歴', kemuri_daily_v1:'日別売上',
    kemuri_costs_v1:'仕入原価',   kemuri_recipes_v1:'レシピ',  kemuri_zaiko_v1:'串打ち前の在庫',
    kemuri_kushiyaki_v1:'串焼き', kemuri_hacchu_v1:'発注'
  };
  /* テスト環境（test-envブランチ）だけの設定：
     書き出すバックアップの印を本番と変える。本番の復元処理は印が
     'kemuri-backup' のファイルしか受け付けないので、テストで作った
     バックアップを本番で読み込むことはできない。
     読み込みは、本番で書き出したもの（'kemuri-backup'）も受け付ける。 */
  var TAG = 'kemuri-backup-TEST';
  var ACCEPT = ['kemuri-backup-TEST', 'kemuri-backup'];
  var FORMAT = 2;                       /* 書き出す形式の版 */
  var MARK = 'kemuri_restore_v1';       /* 復元中の印（途中で止まったときの控え） */

  function ls() { try { return global.localStorage; } catch (e) { return null; } }
  function n(o) { return o && typeof o === 'object' ? Object.keys(o).length : 0; }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function envName() { return global.KEMURI_ENV === 'test' ? 'test' : 'prod'; }
  function hostName() { try { return String(global.location && global.location.host || ''); } catch (e) { return ''; } }

  /* 文字列の検査値（FNV-1a・32bit ＋ 文字数）。在庫アプリの照合と同じ作り */
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16) + ':' + str.length;
  }
  /* 包んだ中身を、端末に書く文字列に戻す */
  function rawOf(v) {
    if (!v || typeof v !== 'object') return null;
    if ('j' in v) { try { return JSON.stringify(v.j); } catch (e) { return null; } }
    return typeof v.s === 'string' ? v.s : null;
  }

  /* その中身が何件ぶんなのかを、人が読める一言にする */
  function describe(key, v) {
    if (v == null) return '';
    if (typeof v !== 'object') return 'あり';
    switch (key) {
      case 'kemuri_reitou_v1': {
        var im = (v.imports || []).filter(function (r) { return !r.undone; }).length;
        return (v.items || []).length + '品目' + (im ? '／取込 ' + im + '件' : '');
      }
      case 'kemuri_sales_v1': {
        var d = Object.keys(v.days || {}).sort();
        return d.length ? d.length + '日ぶん（' + d[0] + '〜' + d[d.length - 1] + '）' : '0日';
      }
      case 'kemuri_daily_v1':   return n(v.days) + '日ぶん';
      case 'kemuri_costs_v1':   return n(v.items) + '件';
      case 'kemuri_recipes_v1': return n(v.items) + '件';
      default:                  return 'あり';
    }
  }
  /* 件数（照合用。書き出したときと読み込むときで比べる） */
  function counts(key, v) {
    if (!isObj(v)) return {};
    switch (key) {
      case 'kemuri_reitou_v1':
        return { items: (v.items || []).length,
                 imports: (v.imports || []).filter(function (r) { return r && !r.undone; }).length,
                 marks: n(v.applied) + n(v.seen), history: (v.history || []).length };
      case 'kemuri_sales_v1': {
        var rows = 0; Object.keys(v.days || {}).forEach(function (d) { rows += n(v.days[d]); });
        return { days: n(v.days), rows: rows, logs: n(v.logs) };
      }
      case 'kemuri_daily_v1':   return { days: n(v.days) };
      case 'kemuri_costs_v1':   return { items: n(v.items) };
      case 'kemuri_recipes_v1': return { items: n(v.items) };
      default:                  return { keys: n(v) };
    }
  }
  function sameCounts(a, b) {
    a = a || {}; b = b || {};
    var ks = Object.keys(a).concat(Object.keys(b));
    for (var i = 0; i < ks.length; i++) if (a[ks[i]] !== b[ks[i]]) return false;
    return true;
  }

  /* 中身の形を確かめる。問題があれば理由（無ければ ''）。
     在庫アプリの checkData と同じ基準（在庫アプリのデータは異常なら停止になるため、
     そもそも入れない） */
  function checkShape(key, v) {
    if (!v || typeof v !== 'object') return '読める形になっていません';
    /* 段階0（レビュー指摘5）：どの種類も、読めない文字のまま入っているものは入れない */
    if (!('j' in v)) return 'バックアップの中でも壊れています（読めない文字のまま入っています）';
    var o = v.j;
    var objOrNone = function (x) { return x == null || isObj(x); };
    var arrOrNone = function (x) { return x == null || Array.isArray(x); };
    var numOrNone = function (x) { return x == null || (typeof x === 'number' && isFinite(x)); };
    switch (key) {
      case 'kemuri_reitou_v1': {
        if (!isObj(o)) return '在庫データの形になっていません';
        if (o.v !== undefined && o.v !== 1) return 'このアプリが対応していない版のデータです（v=' + String(o.v).slice(0, 20) + '）';
        if (!Array.isArray(o.items)) return '品目の一覧（items）がありません';
        for (var i = 0; i < o.items.length; i++) {
          var it = o.items[i];
          if (!isObj(it)) return (i + 1) + '番目の品目が品目の形になっていません';
          if (typeof it.id !== 'number' || !isFinite(it.id)) return (i + 1) + '番目の品目の番号（id）が不正です';
          if (typeof it.name !== 'string') return (i + 1) + '番目の品目の名前（name）が不正です';
          if (it.stock != null && (typeof it.stock !== 'number' || !isFinite(it.stock))) return '「' + it.name + '」の在庫数が数字ではありません';
        }
        var ok1 = function (x) { return x == null || isObj(x); };
        var ks1 = ['map', 'seen', 'applied', 'ordered', 'supCfg'];
        for (var a = 0; a < ks1.length; a++) if (!ok1(o[ks1[a]])) return ks1[a] + ' の形が不正です';
        var ks2 = ['history', 'imports', 'orders', 'sups'];
        for (var b = 0; b < ks2.length; b++) if (o[ks2[b]] != null && !Array.isArray(o[ks2[b]])) return ks2[b] + ' の形が不正です';
        if (o.seq != null && (typeof o.seq !== 'number' || !isFinite(o.seq))) return '連番（seq）が不正です';
        return '';
      }
      case 'kemuri_sales_v1': {
        if (!isObj(o)) return '売上履歴の形になっていません';
        if (!isObj(o.days)) return '日ごとの売上（days）がありません';
        var ds = Object.keys(o.days);
        for (var d = 0; d < ds.length; d++) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds[d])) return '日付の形が不正です（' + ds[d].slice(0, 20) + '）';
          var rows = o.days[ds[d]];
          if (!isObj(rows)) return ds[d] + ' の売上の形が不正です';
          var rk = Object.keys(rows);
          for (var r = 0; r < rk.length; r++) {
            var row = rows[rk[r]];
            if (!isObj(row) || typeof row.qty !== 'number' || !isFinite(row.qty)) return ds[d] + ' の売上の数が数字ではありません';
          }
        }
        var ks3 = ['spans', 'seen', 'closed', 'totals', 'logs'];
        for (var c = 0; c < ks3.length; c++) if (o[ks3[c]] != null && !isObj(o[ks3[c]])) return ks3[c] + ' の形が不正です';
        if (o.order != null && !Array.isArray(o.order)) return 'order の形が不正です';
        return '';
      }
      case 'kemuri_daily_v1': {
        if (!isObj(o) || !isObj(o.days)) return '日別売上（days）の形が不正です';
        var dd = Object.keys(o.days);
        for (var e = 0; e < dd.length; e++) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dd[e])) return '日付の形が不正です（' + dd[e].slice(0, 20) + '）';
          if (!isObj(o.days[dd[e]])) return dd[e] + ' の売上の形が不正です';
        }
        return '';
      }
      case 'kemuri_costs_v1':
      case 'kemuri_recipes_v1': {
        if (!isObj(o) || !isObj(o.items)) return '一覧（items）の形が不正です';
        var ik = Object.keys(o.items);
        for (var f = 0; f < ik.length; f++) {
          var row2 = o.items[ik[f]];
          if (!isObj(row2)) return '一覧の中に、形が不正な行があります';
          if (key === 'kemuri_recipes_v1') {
            /* 再レビュー指摘13：材料（parts）は必ず配列で、1つずつが «名前つきの材料» であること
               （画面の原価計算が材料の名前・数量をそのまま読むため） */
            var rn = '「' + String(row2.name || ik[f]).slice(0, 20) + '」';
            if (!Array.isArray(row2.parts)) return rn + 'の材料（parts）の形が不正です';
            for (var q = 0; q < row2.parts.length; q++) {
              var pt = row2.parts[q];
              if (!isObj(pt) || typeof pt.name !== 'string') return rn + 'の' + (q + 1) + '番目の材料の形が不正です';
              if (!numOrNone(pt.qty)) return rn + 'の' + (q + 1) + '番目の材料の数量が数字ではありません';
            }
          }
        }
        return '';
      }
      /* 段階0（レビュー指摘5）：串焼き・発注・串打ち前の在庫も、各アプリが読める最小の形を確かめる */
      case 'kemuri_kushiyaki_v1': {
        if (!isObj(o)) return '串焼きのデータの形になっていません';
        if (!isObj(o.items)) return '串の一覧（items）がありません';
        var kk = Object.keys(o.items);
        for (var g = 0; g < kk.length; g++) {
          var ki = o.items[kk[g]];
          if (!isObj(ki)) return '「' + kk[g].slice(0, 20) + '」が串の形になっていません';
          if (!arrOrNone(ki.lots)) return '「' + kk[g].slice(0, 20) + '」のロット（lots）の形が不正です';
          for (var h = 0; h < (ki.lots || []).length; h++) {
            var lot = ki.lots[h];
            if (!isObj(lot) || !numOrNone(lot.qty)) return '「' + kk[g].slice(0, 20) + '」のロットの数が数字ではありません';
          }
        }
        var ko = ['applied', 'posMap', 'posMarks'];
        for (var m1 = 0; m1 < ko.length; m1++) if (!objOrNone(o[ko[m1]])) return ko[m1] + ' の形が不正です';
        var ka = ['log', 'losses', 'posLog'];
        for (var m2 = 0; m2 < ka.length; m2++) if (!arrOrNone(o[ka[m2]])) return ka[m2] + ' の形が不正です';
        if (!numOrNone(o.seq)) return '連番（seq）が不正です';
        return '';
      }
      case 'kemuri_hacchu_v1': {
        if (!isObj(o)) return '発注のデータの形になっていません';
        if (!Array.isArray(o.suppliers)) return '業者の一覧（suppliers）がありません';
        if (!Array.isArray(o.products)) return '商品の一覧（products）がありません';
        for (var s1 = 0; s1 < o.suppliers.length; s1++) if (!isObj(o.suppliers[s1])) return (s1 + 1) + '番目の業者の形が不正です';
        for (var p1 = 0; p1 < o.products.length; p1++) if (!isObj(o.products[p1])) return (p1 + 1) + '番目の商品の形が不正です';
        var ho = ['order', 'done', 'sentToday', 'supDates'];
        for (var m3 = 0; m3 < ho.length; m3++) if (!objOrNone(o[ho[m3]])) return ho[m3] + ' の形が不正です';
        if (!arrOrNone(o.history)) return 'history の形が不正です';
        for (var h1 = 0; h1 < (o.history || []).length; h1++) if (!isObj(o.history[h1])) return '履歴の' + (h1 + 1) + '番目の形が不正です';
        return '';
      }
      case 'kemuri_zaiko_v1': {
        if (!isObj(o)) return '串打ち前の在庫のデータの形になっていません';
        if (!arrOrNone(o.ingredients)) return '材料の一覧（ingredients）の形が不正です';
        for (var z = 0; z < (o.ingredients || []).length; z++) if (!isObj(o.ingredients[z])) return (z + 1) + '番目の材料の形が不正です';
        return '';
      }
      default:
        return '';
    }
  }

  /* ===== 復元の控えの置き場所：IndexedDB（段階0・案A） =====
     データベース kemuri-safety ／ 入れ物 restore ／ 名前 current に1件だけ置く。
     { v:2, id, at, keys, prev:{ key: 置きかえる前の文字列 または null } } */
  var IDB_NAME = 'kemuri-safety', IDB_STORE = 'restore', IDB_OLD_KEY = 'current', IDB_WAIT = 8000;
  function idbOpen() {
    return new Promise(function (res, rej) {
      var f = null; try { f = global.indexedDB; } catch (e) {}
      if (!f) return rej(new Error('IndexedDB が使えません'));
      var rq; try { rq = f.open(IDB_NAME, 1); } catch (e) { return rej(e); }
      rq.onupgradeneeded = function () { try { var db = rq.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); } catch (e) {} };
      /* 再レビュー指摘16：«ほかの画面が使用中» などで失敗扱いにしたあとに接続が開いたら、使わずに閉じる */
      var gone = false;
      rq.onsuccess = function () {
        var db = rq.result;
        if (gone) { try { db.close(); } catch (e) {} return; }
        try { db.onversionchange = function () { try { db.close(); } catch (e) {} }; } catch (e) {}
        res(db);
      };
      rq.onerror = function () { gone = true; rej(rq.error || new Error('IndexedDB を開けません')); };
      rq.onblocked = function () { gone = true; rej(new Error('IndexedDB をほかの画面が使っています')); };
    });
  }
  /* 1つの取引で読み書きし、取引が終わってから結果を返す（書いたつもりで終わらない）。
     段階0（レビュー指摘4）：時間切れ（8秒）になった処理は «失効» にする。あとから接続が開いても
     取引を始めずに閉じ、始まっていた取引は取り消す（遅れて動き出して、次の復元の控えを
     消したり置きかえたりしない） */
  function idbDo(mode, fn) {
    return new Promise(function (res, rej) {
      var dead = false, done = false, tx = null;
      var timer = setTimeout(function () {
        if (done) return;
        dead = true;
        try { if (tx) tx.abort(); } catch (e) {}
        rej(new Error('IndexedDB が応答しません'));
      }, IDB_WAIT);
      var finish = function (ok, v) { if (done || dead) return; done = true; clearTimeout(timer); (ok ? res : rej)(v); };
      idbOpen().then(function (db) {
        if (dead) { try { db.close(); } catch (e) {} return; }
        var out;
        try {
          tx = db.transaction(IDB_STORE, mode);
          var rq = fn(tx.objectStore(IDB_STORE));
          if (rq) rq.onsuccess = function () { out = rq.result; };
        } catch (e) { try { db.close(); } catch (e2) {} return finish(false, e); }
        tx.oncomplete = function () { try { db.close(); } catch (e) {} finish(true, out); };
        tx.onerror = tx.onabort = function () { try { db.close(); } catch (e) {} finish(false, tx.error || new Error('IndexedDB に書けません')); };
      }, function (e) { finish(false, e); });
    });
  }
  /* 控えは復元ごとの名前（id）で置く。消すのも、その復元の id だけ */
  function idbPut(id, v) { return idbDo('readwrite', function (st) { return st.put(v, id); }); }
  function idbGet(id) { return idbDo('readonly', function (st) { return st.get(id); }); }
  function idbDel(id) { return idbDo('readwrite', function (st) { return st['delete'](id); }); }
  function idbKeys() { return idbDo('readonly', function (st) { return st.getAllKeys(); }); }
  /* 古い控えの掃除（再レビュー指摘11）。全部は消さない。
     1つの取引の中で、その時点の «復元中の印» を読み直し、印が指している id の控えは残して、
     それ以外だけを消す。印を読むのは接続が開いたあと（取引の中）なので、開くのを待っているあいだに
     始まった復元の控えを、印を置いたあとに消すことはない。印を置く前の控えを消してしまった場合は、
     復元の側が «印を置いたあとの読み直し» で気づいて、何も書かずにやめる */
  function idbSweep() {
    return idbDo('readwrite', function (st) {
      var keep = null;
      try { var raw = ls().getItem(MARK); if (raw != null) { var m = JSON.parse(raw); if (isObj(m) && m.copy === 'idb') keep = m.id; } } catch (e) { return null; }
      var rq = st.getAllKeys();
      rq.onsuccess = function () {
        (rq.result || []).forEach(function (k) {
          if (keep != null && (k === keep || k === IDB_OLD_KEY)) return;   /* 印の控え（旧い置き方も）は残す */
          st['delete'](k);
        });
      };
      return null;
    });
  }
  var RUNNING = false;   /* 同じ画面で、復元・片付けを二重に動かさない（再レビュー指摘11） */
  /* 印の id に合う控えを読む。前の版（名前 current に1件だけ置いていた）で止まった復元にも対応 */
  function idbFind(id) {
    return idbGet(id).then(function (rec) {
      if (rec && rec.id === id) return rec;
      return idbGet(IDB_OLD_KEY).then(function (old) { return old && old.id === id ? old : null; });
    });
  }
  function markGone() { try { return ls().getItem(MARK) == null; } catch (e) { return false; } }
  function quiet(p) { return p.then(function () { return true; }, function () { return false; }); }

  /* 保存場所の量（iPhone の数え方）：Latin-1 の外の文字を1つでも含む文字列は1文字2バイト、
     そうでなければ1文字1バイト。iPhone の上限は 5MB（5,242,880バイト）で、実機の測定と一致した */
  var QUOTA_GUESS = 5242880;
  function wideStr(t) { return /[^\u0000-\u00ff]/.test(t); }
  function lsBytes(k, v) { if (v == null) return 0; return (wideStr(k) ? 2 : 1) * k.length + (wideStr(v) ? 2 : 1) * v.length; }

  var Backup = {
    KEYS: KEYS,
    MARK: MARK,
    FORMAT: FORMAT,
    hash: hash,

    /* いまの中身を集める。無いキーは入れない（第2形式：検査値・件数つき） */
    collect: function () {
      var s = ls(), data = {}, meta = {};
      var box = { tag: TAG, v: FORMAT, at: new Date().toISOString(), env: envName(), host: hostName(),
                  data: data, meta: meta, idb: {} };
      if (!s) return box;
      KEYS.forEach(function (k) {
        var raw;
        try { raw = s.getItem(k); } catch (e) { return; }
        if (raw == null) return;
        /* 読める形なら JSON として、駄目なら文字列のまま包む */
        try { data[k] = { j: JSON.parse(raw) }; } catch (e) { data[k] = { s: raw }; }
        var w = rawOf(data[k]);
        meta[k] = { hash: hash(w), len: w.length, count: counts(k, data[k].j) };
      });
      return box;
    },

    text: function () { return JSON.stringify(this.collect()); },

    /* 書き出したもの／読み込もうとしているものの中身を一覧にする */
    summary: function (box) {
      var data = (box && box.data) || {};
      return KEYS.filter(function (k) { return data[k] !== undefined; })
        .map(function (k) {
          var v = data[k];
          var val = v && ('j' in v) ? v.j : null;
          return { key: k, label: LABEL[k] || k, detail: describe(k, val) };
        });
    },

    /* 文字列を読んで、バックアップとして通るか確かめる。
       駄目なら null を返す（呼んだ側で «読めません» と出す）。
       第1形式・第2形式のどちらも読む。 */
    parse: function (text) {
      var box;
      try { box = JSON.parse(String(text || '').trim()); } catch (e) { return null; }
      if (!box || typeof box !== 'object') return null;
      /* 昔の «在庫アプリだけ» の書き出しも受け取れるようにしておく */
      if (!box.tag && Array.isArray(box.items)) {
        return { tag: TAG, v: 1, at: '', old: true, data: { kemuri_reitou_v1: { j: box } } };
      }
      if (ACCEPT.indexOf(box.tag) < 0 || !box.data || typeof box.data !== 'object') return null;
      if (box.v !== undefined && box.v !== 1 && box.v !== 2) return null;     /* 知らない形式は読まない */
      var any = KEYS.some(function (k) { return box.data[k] !== undefined; });
      return any ? box : null;
    },

    /* 読み込む前の確かめ。keys を省くと入っている全部。
       戻り値 { ok, problems:[{key,label,why}] }
       ・形（在庫・売上履歴は在庫アプリと同じ基準）
       ・第2形式なら、検査値・文字数・件数が書き出したときと一致するか */
    validate: function (box, keys) {
      var problems = [];
      if (!box || !box.data) return { ok: false, problems: [{ key: '', label: '', why: 'バックアップとして読めません' }] };
      var list = Array.isArray(keys) ? keys : KEYS.filter(function (k) { return box.data[k] !== undefined; });
      list.forEach(function (k) {
        var v = box.data[k];
        if (KEYS.indexOf(k) < 0) { problems.push({ key: k, label: k, why: '知らない種類のデータです' }); return; }
        if (v === undefined) { problems.push({ key: k, label: LABEL[k], why: 'このファイルには入っていません' }); return; }
        var why = checkShape(k, v);
        /* 段階0（レビュー指摘10）：第2形式なら検査値の部分（meta）が必ず要る。丸ごと無いものは通さない */
        if (!why && box.v === 2 && !isObj(box.meta)) why = '検査値がありません（ファイルが書きかわった可能性があります）';
        if (!why && box.v === 2) {
          var m = box.meta[k], w = rawOf(v);
          if (!m) why = '検査値がありません（ファイルが書きかわった可能性があります）';
          else if (w == null || m.hash !== hash(w) || m.len !== w.length) why = '検査値が一致しません（ファイルが途中で切れた・書きかわった可能性があります）';
          else if ('j' in v && !sameCounts(m.count, counts(k, v.j))) why = '件数が書き出したときと一致しません';
        }
        if (why) problems.push({ key: k, label: LABEL[k] || k, why: why });
      });
      return { ok: problems.length === 0, problems: problems };
    },

    /* いまこの端末に入っているものを、読み込もうとしているものと同じ形で一覧にする。
       «何が何に置きかわるのか» を、読み込む前に見せるため。 */
    current: function () {
      var box = this.collect(), out = {};
      this.summary(box).forEach(function (x) { out[x.key] = x.detail; });
      return out;
    },

    /* （旧）読み込む。1つずつ書くだけで、途中で失敗しても戻さない。
       各アプリはもう使っていない（applySafe を使う）。互換のために残す。 */
    apply: function (box, only) {
      var s = ls(), ok = [], ng = [];
      var pick = Array.isArray(only) ? only : null;
      if (!s || !box || !box.data) return { ok: ok, ng: KEYS.slice() };
      KEYS.forEach(function (k) {
        var v = box.data[k];
        if (v === undefined) return;
        if (pick && pick.indexOf(k) < 0) return;
        var raw = rawOf(v);
        if (raw == null) return;
        try { s.setItem(k, raw); ok.push(k); } catch (e) { ng.push(k); }
      });
      return { ok: ok, ng: ng };
    },

    /* 安全な復元。呼ぶ側が編集権を持っている間に、同期で呼ぶこと。
       keys … 入れるキー（選んだもの）
       opts.who … 誰が復元したか（印に残す）
       opts.fail … テスト用：このキーの書き込みを失敗させる
       opts.stopAfter … テスト用：このキーを書いたところで止める（途中で落ちた状態を作る）
       戻り値 { ok, written:[キー], why, failedKey, rolledBack, markLeft } */
    applySafe: function (box, keys, opts) {
      var self = this;
      if (RUNNING) return Promise.resolve({ ok: false, written: [], why: '別の読み込み・片付けが動いています。終わってから、もう一度押してください（何も変えていません）', busy: true });
      RUNNING = true;
      return self._applySafe(box, keys, opts).then(function (r) { RUNNING = false; return r; }, function (e) { RUNNING = false; throw e; });
    },
    _applySafe: function (box, keys, opts) {
      var self = this;
      return (async function () {
      opts = opts || {};
      var s = ls();
      var res = { ok: false, written: [], why: '', failedKey: '', rolledBack: false, markLeft: false, copyIn: '', idbWhy: '' };
      if (!s) { res.why = '端末の保存場所が使えません'; return res; }
      var list = KEYS.filter(function (k) { return keys.indexOf(k) >= 0 && box && box.data && box.data[k] !== undefined; });
      if (!list.length) { res.why = '入れるものがありません'; return res; }
      var chk = self.validate(box, list);
      if (!chk.ok) { res.why = chk.problems.map(function (p) { return p.label + '：' + p.why; }).join('\n'); return res; }
      try { if (s.getItem(MARK) != null) { res.why = '前の復元が途中で止まったままです。先にその確認をしてください'; return res; } }
      catch (e) { res.why = '端末から読み出せませんでした'; return res; }

      /* 書く中身を先に作る（在庫アプリのデータは版番号を今より先へ進める：
         古いバックアップでも «新しい保存» として他の画面が読み直すように） */
      var want = {}, prev = {};
      for (var i = 0; i < list.length; i++) {
        var k = list[i], w = rawOf(box.data[k]);
        if (w == null) { res.why = LABEL[k] + '：中身を取り出せません'; return res; }
        var cur;
        try { cur = s.getItem(k); } catch (e) { res.why = '端末から読み出せませんでした'; return res; }
        prev[k] = cur;
        if (k === 'kemuri_reitou_v1') {
          var o = JSON.parse(w), curRev = 0;
          try { curRev = Number(JSON.parse(cur).rev) || 0; } catch (e) {}
          o.rev = Math.max(curRev, Number(o.rev) || 0) + 1;
          o.wid = 'restore-' + Date.now().toString(36);
          w = JSON.stringify(o);
        }
        want[k] = w;
      }
      var wantHash = {}, sum = {};
      list.forEach(function (k) { wantHash[k] = hash(want[k]); sum[k] = prev[k] == null ? null : hash(prev[k]); });
      var at = new Date().toISOString(), id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

      /* ① 控えを IndexedDB に書いて、読み直して完全に一致するか確かめる。
         印が無いのに残っている古い控え（片付けの途中で落ちたもの）は、先に消す */
      var useIdb = !opts.noIdb;
      if (useIdb) {
        try {
          await idbPut(id, { v: 2, id: id, at: at, keys: list, prev: prev });
          var back = await idbGet(id);
          var same = !!back && back.id === id && isObj(back.prev) && list.every(function (k) { return back.prev[k] === prev[k]; });
          if (!same) throw new Error('控えを読み直したら中身が一致しませんでした');
        } catch (e) {
          useIdb = false; res.idbWhy = String(e && e.message || e);
          await quiet(idbDel(id));
        }
      }
      /* 段階0（レビュー指摘1）：控えを作って待っているあいだに、ほかの画面が保存していないか・
         別の復元が始まっていないかを、印を置く直前にもう一度確かめる。変わっていたら何も書かずにやめる
         （控えが最新でないまま上書きしない） */
      var changed = [], markNow = null, readErr = false;
      try {
        markNow = s.getItem(MARK);
        list.forEach(function (k) { if (s.getItem(k) !== prev[k]) changed.push(k); });
      } catch (e) { readErr = true; }
      if (readErr || markNow != null || changed.length) {
        if (useIdb) await quiet(idbDel(id));
        res.conflict = true;
        res.why = readErr ? '端末から読み出せませんでした（何も変えていません）'
          : markNow != null ? '別の復元が始まっていました（何も変えていません）。先にその確認をしてください'
          : '読み込みの準備をしているあいだに、別の画面でデータが変わりました（' + changed.map(function (k) { return LABEL[k] || k; }).join('、') + '）。\n何も変えていません。もう一度、ファイルを選ぶところからやり直してください';
        return res;
      }
      /* 印：IndexedDB に控えがあるときは小さい印（v:2）。無いときはこれまでどおり印に控えを入れる（v:1） */
      var mark = useIdb
        ? { v: 2, copy: 'idb', id: id, at: at, who: opts.who || '', from: box.at || '', keys: list, sum: sum, want: wantHash }
        : { v: 1, at: at, who: opts.who || '', from: box.at || '', keys: list, prev: prev, want: wantHash };
      var ms;
      try { ms = JSON.stringify(mark); s.setItem(MARK, ms); }
      catch (e) {
        try { s.removeItem(MARK); } catch (e2) {}
        if (useIdb && markGone()) await quiet(idbDel(id));
        res.why = useIdb ? '復元中の印を書けませんでした（端末の空き容量が足りない可能性があります。何も変えていません）'
                         : '端末の空き容量が足りないため、元に戻せる控えを作れませんでした（何も変えていません）'
                           + (res.idbWhy ? '\n（IndexedDB に控えを置けませんでした：' + res.idbWhy + '）' : '');
        return res;
      }
      var mok = false; try { mok = s.getItem(MARK) === ms; } catch (e) {}
      if (!mok) {
        try { s.removeItem(MARK); } catch (e) {}
        if (useIdb && markGone()) await quiet(idbDel(id));
        res.why = '控えを確かめられませんでした（何も変えていません）'; return res;
      }
      /* 再レビュー指摘11：印を置いたあとに、控えがまだあるかをもう一度読む（ほかの画面の掃除が、
         印を置く前のすき間に消していないか）。無ければ、まだ何も書いていないので印を外してやめる */
      if (useIdb) {
        var still = null; try { still = await idbGet(id); } catch (e) {}
        if (!still || still.id !== id) {
          try { s.removeItem(MARK); } catch (e) {}
          res.conflict = true;
          res.why = '控えを確かめられませんでした（ほかの画面の片付けと重なった可能性があります）。何も変えていません。もう一度やり直してください';
          if (!markGone()) res.markLeft = true;
          return res;
        }
      }
      res.copyIn = useIdb ? 'idb' : 'ls';

      /* ② 1つずつ書いて読み直す */
      for (var j = 0; j < list.length; j++) {
        var key = list[j], good = false;
        /* 段階0（レビュー指摘1）：書く直前にも、その種類が控えたときのままか確かめる。変わっていたら
           その種類には触れず、書いたぶんだけ元に戻してやめる（ほかの画面の変更を消さない） */
        var curNow; try { curNow = s.getItem(key); } catch (e) { curNow = undefined; }
        if (curNow !== prev[key]) {
          res.conflict = true; res.failedKey = key;
          res.why = LABEL[key] + ' が、読み込みの途中に別の画面で変わりました。その変更を消さないよう、読み込みをやめました';
          var bk0 = self._rollback(prev, res.written);
          res.rolledBack = bk0.ok;
          if (bk0.ok) { try { s.removeItem(MARK); } catch (e) {} }
          if (bk0.ok && markGone()) { if (useIdb) await quiet(idbDel(id)); res.why += '（先に入れたぶんは元に戻しました）'; }
          else res.markLeft = true;
          return res;
        }
        try {
          if (opts.fail === key) throw new Error('test-fail');
          s.setItem(key, want[key]);
          good = s.getItem(key) === want[key];
        } catch (e) { good = false; }
        if (!good) {
          res.failedKey = key;
          res.why = LABEL[key] + ' を書き込めませんでした（端末の空き容量が足りない可能性があります）';
          /* ③ 巻き戻し（書いたぶん＋失敗したキーを、控えの中身に戻す。控えは手元にも持っている） */
          var bk = self._rollback(prev, res.written.concat([key]));
          res.rolledBack = bk.ok;
          /* 段階0（レビュー指摘9）：印が消えたのを確かめてから控えを消す。印が残ったら控えも残す */
          if (bk.ok) { try { if (!opts.failMarkRemove) s.removeItem(MARK); } catch (e) {} }
          if (bk.ok && markGone()) { if (useIdb) await quiet(idbDel(id)); }
          else res.markLeft = true;
          return res;
        }
        res.written.push(key);
        if (opts.stopAfter === key) { res.why = 'test-stop'; res.markLeft = true; return res; }
      }
      /* ④ 全部入った → 印を消してから控えを消す（逆だと、途中で落ちたときに印だけ残る） */
      try { s.removeItem(MARK); } catch (e) {}
      if (!markGone()) res.markLeft = true;
      if (useIdb && !res.markLeft) { await quiet(idbDel(id)); await quiet(idbSweep()); }
      res.ok = true;
      return res;
      })();
    },

    /* この復元で一時的に使う保存場所の量の見込み（iPhone の数え方・バイト）。
       { peak：案A（控えは IndexedDB）でいちばん多いとき, peakLs：控えも localStorage に置くとき,
         after：終わったあと, quota：iPhone の上限, pct, pctLs } */
    estimate: function (box, keys) {
      var s = ls(), out = { peak: 0, peakLs: 0, after: 0, quota: QUOTA_GUESS, pct: 0, pctLs: 0 };
      if (!s || !box || !box.data) return out;
      var list = KEYS.filter(function (k) { return keys.indexOf(k) >= 0 && box.data[k] !== undefined; });
      var cur = {}, others = 0, want = {};
      try {
        for (var i = 0; i < s.length; i++) {
          var k = s.key(i), v = s.getItem(k);
          if (list.indexOf(k) >= 0) cur[k] = v; else if (k !== MARK) others += lsBytes(k, v);
        }
      } catch (e) { return out; }
      list.forEach(function (k) { want[k] = rawOf(box.data[k]) || ''; });
      var small = 1200;   /* 小さい印（v:2）のぶん */
      list.forEach(function (k, idx) {
        var t = others + small;
        list.forEach(function (kk, j) { t += lsBytes(kk, j <= idx ? want[kk] : (cur[kk] == null ? null : cur[kk])); });
        if (t > out.peak) out.peak = t;
      });
      var markLs = JSON.stringify({ prev: cur });
      out.peakLs = out.peak - small + lsBytes(MARK, markLs);
      out.after = others; list.forEach(function (k) { out.after += lsBytes(k, want[k]); });
      out.pct = Math.round(out.peak / QUOTA_GUESS * 100);
      out.pctLs = Math.round(out.peakLs / QUOTA_GUESS * 100);
      return out;
    },

    /* 控えの中身に戻す（無かったキーは消す）。全部戻せたら ok */
    _rollback: function (prev, keys) {
      var s = ls(), bad = [];
      /* 後に書いたほうから戻す。すでに控えと同じ中身（書き込みに失敗したキーなど）は書かない
         （容量が足りないときに、要らない書き込みで失敗しないように） */
      keys.slice().reverse().forEach(function (k) {
        if (!(k in prev)) return;
        try {
          if (s.getItem(k) === prev[k]) return;
          if (prev[k] == null) { s.removeItem(k); if (s.getItem(k) != null) bad.push(k); }
          else { s.setItem(k, prev[k]); if (s.getItem(k) !== prev[k]) bad.push(k); }
        } catch (e) { bad.push(k); }
      });
      return { ok: bad.length === 0, bad: bad };
    },

    /* 途中で止まった復元があるか。無ければ null。
       { at, who, keys, done:[入り終わっていたキー], rest:[まだのキー], prevKeys, broken } */
    pendingRestore: function () {
      var s = ls(), raw = null;
      if (!s) return null;
      try { raw = s.getItem(MARK); } catch (e) { return { broken: true, why: '端末から読み出せませんでした', keys: [], done: [], rest: [] }; }
      if (raw == null) return null;
      var m; try { m = JSON.parse(raw); } catch (e) { m = null; }
      /* v:2 は控えが IndexedDB（印には検査値 sum だけ）、v:1（旧形式）は印の中に控え（prev） */
      var v2 = isObj(m) && m.copy === 'idb';
      if (!isObj(m) || !Array.isArray(m.keys) || !(v2 ? isObj(m.sum) : isObj(m.prev)) || !isObj(m.want))
        return { broken: true, why: '復元中の印が壊れています', keys: [], done: [], rest: [] };
      var done = [], rest = [];
      m.keys.forEach(function (k) {
        var cur = null; try { cur = s.getItem(k); } catch (e) {}
        if (cur != null && hash(cur) === m.want[k]) done.push(k); else rest.push(k);
      });
      return { at: m.at, who: m.who, from: m.from, keys: m.keys, done: done, rest: rest, copy: v2 ? 'idb' : 'ls' };
    },

    /* 途中で止まった復元を片付ける。呼ぶ側が編集権を持っている間に呼ぶ。戻り値は Promise
       how … 'back'：復元前の中身に戻す（控えから。v:2 は IndexedDB の控えを読み、印の検査値と
                     合うことを確かめてから戻す）
             'keep'：全部入り終わっていたときだけ、印を消してそのまま使う
             'drop'：控えが見つからず戻せないときだけ使う。印と控えを片付ける（中身はそのまま。
                     このあと同じバックアップを読み込み直して、最後まで入れる）
       戻り値 { ok, why, noCopy } */
    resolveRestore: function (how) {
      var self = this;
      if (RUNNING) return Promise.resolve({ ok: false, why: '別の読み込み・片付けが動いています。終わってから、もう一度押してください（何も変えていません）', busy: true });
      RUNNING = true;
      return self._resolveRestore(how).then(function (r) { RUNNING = false; return r; }, function (e) { RUNNING = false; throw e; });
    },
    _resolveRestore: function (how) {
      var self = this;
      return (async function () {
      var s = ls(), raw = null;
      try { raw = s.getItem(MARK); } catch (e) { return { ok: false, why: '端末から読み出せませんでした' }; }
      if (raw == null) { await quiet(idbSweep()); return { ok: true, why: '' }; }
      var m; try { m = JSON.parse(raw); } catch (e) { m = null; }
      var v2 = isObj(m) && m.copy === 'idb';
      if (how === 'keep') {
        var p = self.pendingRestore();
        if (!p || p.broken || p.rest.length) return { ok: false, why: '入り終わっていないデータがあるため、このままにはできません' };
        try { s.removeItem(MARK); } catch (e) {}
        if (!markGone()) return { ok: false, why: '印を消せませんでした' };
        if (v2) await quiet(idbSweep());
        return { ok: true, why: '' };
      }
      if (how === 'drop') {
        try { s.removeItem(MARK); } catch (e) {}
        if (!markGone()) return { ok: false, why: '印を消せませんでした' };
        await quiet(idbSweep());
        return { ok: true, why: '' };
      }
      if (how === 'back') {
        if (!isObj(m) || !Array.isArray(m.keys)) return { ok: false, why: '控えが壊れているため戻せません' };
        var prev = null;
        if (v2) {
          var rec = null, err = '';
          try { rec = await idbFind(m.id); } catch (e) { err = String(e && e.message || e); }
          if (!rec || rec.id !== m.id || !isObj(rec.prev))
            return { ok: false, noCopy: true, why: '控え（復元する前の中身）が見つかりません' + (err ? '（' + err + '）' : '') + '。\n戻せないため、何も変えていません' };
          var bad = m.keys.filter(function (k) { return (rec.prev[k] == null ? null : hash(rec.prev[k])) !== (m.sum[k] == null ? null : m.sum[k]); });
          if (bad.length)
            return { ok: false, noCopy: true, why: '控えの中身が印と合いません（' + bad.map(function (k) { return LABEL[k] || k; }).join('、') + '）。\n別の中身に戻すおそれがあるため、何も変えていません' };
          prev = rec.prev;
        } else {
          if (!isObj(m.prev)) return { ok: false, why: '控えが壊れているため戻せません' };
          prev = m.prev;
        }
        var back = self._rollback(prev, m.keys);
        if (!back.ok) return { ok: false, why: '戻せなかったデータがあります（' + back.bad.map(function (k) { return LABEL[k] || k; }).join('、') + '）' };
        try { s.removeItem(MARK); } catch (e) {}
        /* 中身は戻せている。印が消えたのを確かめてから控えを消す（消せなければ控えを残して知らせる） */
        if (!markGone()) return { ok: false, why: '中身は元に戻しましたが、復元中の印を消せませんでした。もう一度押してください' };
        if (v2) await quiet(idbSweep());
        return { ok: true, why: '' };
      }
      return { ok: false, why: '' };
      })();
    },

    /* 控え（復元する前の中身）を、書き出し用の文字にする（v:2 は IndexedDB から読んで、
       旧形式と同じ «prev 入り» の形にする）。戻り値は Promise（無ければ null） */
    restoreCopyText: function () {
      return (async function () {
        var raw = null; try { raw = ls().getItem(MARK); } catch (e) { return null; }
        if (raw == null) return null;
        var m; try { m = JSON.parse(raw); } catch (e) { return raw; }
        if (!isObj(m) || m.copy !== 'idb') return raw;
        var rec = null; try { rec = await idbFind(m.id); } catch (e) {}
        var o = {}; for (var x in m) o[x] = m[x];
        o.prev = rec && rec.id === m.id ? rec.prev : null;
        if (!o.prev) o.note = '控え（IndexedDB）が見つかりませんでした';
        return JSON.stringify(o);
      })();
    },
    /* IndexedDB の控えを消す（試験データを消すとき用）。印が残っているときは消さない */
    clearRestoreCopy: function () {
      var raw = null; try { raw = ls().getItem(MARK); } catch (e) {}
      if (raw != null) return Promise.resolve(false);
      return quiet(idbSweep());
    },
    /* IndexedDB の控えがあるか（試験・確かめる用）。Promise<{ has, id, keys }> */
    restoreCopyInfo: function () {
      return idbKeys().then(function (ks) { return ks && ks.length ? { has: true, ids: ks } : { has: false }; },
                           function (e) { return { has: false, error: String(e && e.message || e) }; });
    },

    /* 印の中の «復元前の中身» を、そのままファイルにするための文字（調べる・相談する用） */
    restoreMarkText: function () { try { return ls().getItem(MARK); } catch (e) { return null; } },

    /* 保存するときのファイル名。日時が入っていれば、あとで見分けられる */
    filename: function (kind) {
      var d = new Date(), p = function (x) { return ('0' + x).slice(-2); };
      return 'TEST_kemuri-' + (kind || 'backup') + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
           + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    },
    label: function (k) { return LABEL[k] || k; },
    counts: counts
  };

  global.KemuriBackup = Backup;
  if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
})(typeof window !== 'undefined' ? window : globalThis);
