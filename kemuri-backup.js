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
   ・呼ぶ側が編集権（鍵 kemuri-reitou-editor）を持っている間だけ使う
   ・① 先に «復元中の印»（kemuri_restore_v1）に、置きかえる前の中身を控える
       → 控えが書けなければ（容量不足など）何も変えずにやめる
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
    if (!('j' in v)) return key === 'kemuri_reitou_v1' || key === 'kemuri_sales_v1'
      ? 'バックアップの中でも壊れています（読めない文字のまま入っています）' : '';
    var o = v.j;
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
      case 'kemuri_daily_v1':
        return isObj(o) && isObj(o.days) ? '' : '日別売上（days）の形が不正です';
      case 'kemuri_costs_v1':
      case 'kemuri_recipes_v1':
        return isObj(o) && isObj(o.items) ? '' : '一覧（items）の形が不正です';
      default:
        return '';
    }
  }

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
        if (!why && box.v === 2 && box.meta) {
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
      opts = opts || {};
      var s = ls();
      var res = { ok: false, written: [], why: '', failedKey: '', rolledBack: false, markLeft: false };
      if (!s) { res.why = '端末の保存場所が使えません'; return res; }
      var list = KEYS.filter(function (k) { return keys.indexOf(k) >= 0 && box && box.data && box.data[k] !== undefined; });
      if (!list.length) { res.why = '入れるものがありません'; return res; }
      var chk = this.validate(box, list);
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
      /* ① 置きかえる前の中身を印に控える。書けなければ何も変えずにやめる */
      var mark = { v: 1, at: new Date().toISOString(), who: opts.who || '', from: box.at || '',
                   keys: list, prev: prev, want: {} };
      list.forEach(function (k) { mark.want[k] = hash(want[k]); });
      var ms;
      try { ms = JSON.stringify(mark); s.setItem(MARK, ms); }
      catch (e) {
        try { s.removeItem(MARK); } catch (e2) {}
        res.why = '端末の空き容量が足りないため、元に戻せる控えを作れませんでした（何も変えていません）';
        return res;
      }
      var mok = false; try { mok = s.getItem(MARK) === ms; } catch (e) {}
      if (!mok) { try { s.removeItem(MARK); } catch (e) {} res.why = '控えを確かめられませんでした（何も変えていません）'; return res; }

      /* ② 1つずつ書いて読み直す */
      for (var j = 0; j < list.length; j++) {
        var key = list[j], good = false;
        try {
          if (opts.fail === key) throw new Error('test-fail');
          s.setItem(key, want[key]);
          good = s.getItem(key) === want[key];
        } catch (e) { good = false; }
        if (!good) {
          res.failedKey = key;
          res.why = LABEL[key] + ' を書き込めませんでした（端末の空き容量が足りない可能性があります）';
          /* ③ 巻き戻し（書いたぶん＋失敗したキーを、控えの中身に戻す） */
          var back = this._rollback(prev, res.written.concat([key]));
          res.rolledBack = back.ok;
          if (back.ok) { try { s.removeItem(MARK); } catch (e) {} }
          else res.markLeft = true;
          return res;
        }
        res.written.push(key);
        if (opts.stopAfter === key) { res.why = 'test-stop'; res.markLeft = true; return res; }
      }
      /* ④ 全部入った → 印を消す */
      try { s.removeItem(MARK); } catch (e) { res.markLeft = true; }
      res.ok = true;
      return res;
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
      if (!isObj(m) || !Array.isArray(m.keys) || !isObj(m.prev) || !isObj(m.want))
        return { broken: true, why: '復元中の印が壊れています', keys: [], done: [], rest: [] };
      var done = [], rest = [];
      m.keys.forEach(function (k) {
        var cur = null; try { cur = s.getItem(k); } catch (e) {}
        if (cur != null && hash(cur) === m.want[k]) done.push(k); else rest.push(k);
      });
      return { at: m.at, who: m.who, from: m.from, keys: m.keys, done: done, rest: rest };
    },

    /* 途中で止まった復元を片付ける。呼ぶ側が編集権を持っている間に呼ぶ。
       how … 'back'：復元前の中身に戻す（控えから）
             'keep'：全部入り終わっていたときだけ、印を消してそのまま使う
       戻り値 { ok, why } */
    resolveRestore: function (how) {
      var s = ls(), raw = null;
      try { raw = s.getItem(MARK); } catch (e) { return { ok: false, why: '端末から読み出せませんでした' }; }
      if (raw == null) return { ok: true, why: '' };
      var m; try { m = JSON.parse(raw); } catch (e) { m = null; }
      if (how === 'keep') {
        var p = this.pendingRestore();
        if (!p || p.broken || p.rest.length) return { ok: false, why: '入り終わっていないデータがあるため、このままにはできません' };
        try { s.removeItem(MARK); } catch (e) { return { ok: false, why: '印を消せませんでした' }; }
        return { ok: true, why: '' };
      }
      if (how === 'back') {
        if (!isObj(m) || !Array.isArray(m.keys) || !isObj(m.prev)) return { ok: false, why: '控えが壊れているため戻せません' };
        var back = this._rollback(m.prev, m.keys);
        if (!back.ok) return { ok: false, why: '戻せなかったデータがあります（' + back.bad.map(function (k) { return LABEL[k] || k; }).join('、') + '）' };
        try { s.removeItem(MARK); } catch (e) {}
        return { ok: true, why: '' };
      }
      return { ok: false, why: '' };
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
