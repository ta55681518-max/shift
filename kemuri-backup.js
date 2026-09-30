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
  var TAG = 'kemuri-backup';

  function ls() { try { return global.localStorage; } catch (e) { return null; } }
  function n(o) { return o && typeof o === 'object' ? Object.keys(o).length : 0; }

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

  var Backup = {
    KEYS: KEYS,

    /* いまの中身を集める。無いキーは入れない */
    collect: function () {
      var s = ls(), data = {};
      if (!s) return { tag: TAG, v: 1, at: new Date().toISOString(), data: data };
      KEYS.forEach(function (k) {
        var raw;
        try { raw = s.getItem(k); } catch (e) { return; }
        if (raw == null) return;
        /* 読める形なら JSON として、駄目なら文字列のまま包む */
        try { data[k] = { j: JSON.parse(raw) }; } catch (e) { data[k] = { s: raw }; }
      });
      return { tag: TAG, v: 1, at: new Date().toISOString(), data: data };
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
       駄目なら null を返す（呼んだ側で «読めません» と出す） */
    parse: function (text) {
      var box;
      try { box = JSON.parse(String(text || '').trim()); } catch (e) { return null; }
      if (!box || typeof box !== 'object') return null;
      /* 昔の «在庫アプリだけ» の書き出しも受け取れるようにしておく */
      if (!box.tag && Array.isArray(box.items)) {
        return { tag: TAG, v: 1, at: '', old: true, data: { kemuri_reitou_v1: { j: box } } };
      }
      if (box.tag !== TAG || !box.data || typeof box.data !== 'object') return null;
      var any = KEYS.some(function (k) { return box.data[k] !== undefined; });
      return any ? box : null;
    },

    /* いまこの端末に入っているものを、読み込もうとしているものと同じ形で一覧にする。
       «何が何に置きかわるのか» を、読み込む前に見せるため。 */
    current: function () {
      var box = this.collect(), out = {};
      this.summary(box).forEach(function (x) { out[x.key] = x.detail; });
      return out;
    },

    /* 読み込む。書かれているキーだけを置きかえ、書かれていないキーは触らない。
       only に配列を渡すと、そのキーだけを入れる（選んで戻せるように）。
       別の端末から «売上だけ» もらいたいのに、棚卸したばかりの在庫まで
       置きかわってしまう、という事故を防ぐため。
       戻り値 … { ok:[キー], ng:[キー] } */
    apply: function (box, only) {
      var s = ls(), ok = [], ng = [];
      var pick = Array.isArray(only) ? only : null;
      if (!s || !box || !box.data) return { ok: ok, ng: KEYS.slice() };
      KEYS.forEach(function (k) {
        var v = box.data[k];
        if (v === undefined) return;
        if (pick && pick.indexOf(k) < 0) return;
        var raw = v && ('j' in v) ? JSON.stringify(v.j) : (v && v.s);
        if (raw == null) return;
        try { s.setItem(k, raw); ok.push(k); } catch (e) { ng.push(k); }
      });
      return { ok: ok, ng: ng };
    },

    /* 保存するときのファイル名。日時が入っていれば、あとで見分けられる */
    filename: function () {
      var d = new Date(), p = function (x) { return ('0' + x).slice(-2); };
      return 'kemuri-backup-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
           + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
    },
    label: function (k) { return LABEL[k] || k; }
  };

  global.KemuriBackup = Backup;
  if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
})(typeof window !== 'undefined' ? window : globalThis);
