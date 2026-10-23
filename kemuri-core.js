/* ============================================================
   串焼KEMURI屋 共通土台  kemuri-core.js
   ------------------------------------------------------------
   各アプリ（冷凍在庫・串在庫・発注）が共通で使う小道具と、
   「売上の履歴」をためておく置き場。

   ・保存先 … localStorage['kemuri_sales_v1']（この端末のみ）
   ・ここは「ためる・読む」だけ。在庫を動かす処理は各アプリのまま。
   ・なぜ要るか … 今までは「在庫から引いた記録」しか残っておらず、
     日別×商品の売れ数が残っていなかった。翌日の予測・売れ筋・
     原価率を出すには、この履歴が土台になる。

   使う側（HTML）は
     <script src="kemuri-core.js"></script>
   を、アプリ本体の script より先に読み込むだけ。
   ============================================================ */
(function (global) {
  'use strict';

  var SALES_KEY = 'kemuri_sales_v1';
  var KEEP_DAYS = 500;   // 履歴を残す日数（これより古い日は捨てる）
  var KEEP_LOGS = 30;    // 取消できる取込の件数
  var MAX_SEEN  = 40000; // 「取込済みの印」の上限（超えたら古い日ごと捨てる）
  var TICKET_DAYS = 120; // 伝票1行ずつの印を持っておく日数。これより古い日は
                         // 「この日はもう取り込んだ」という印1つにまとめる。
                         // 明細CSVは1晩で数百行あり、1年ぶん持つと端末に入らない。
  /* 印は必ず「その日」を控える。日ごと捨てれば印も一緒に消えるので、
     “日は残っているのに印だけ消えた”状態が起きない＝同じCSVを
     入れ直しても二重に足されない。ここが崩れると売上が水増しされる。 */

  /* ---------- 小道具 ----------
     ※ num / norm は冷凍在庫アプリと同じ実装。
        norm は「POS商品名の対応表」のキーを作るのに使っているので、
        ここを変えると既存の対応表が引けなくなる。触らないこと。 */
  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]/g, '').toLowerCase();
  }

  /* ---------- 日付 ---------- */
  function z2(n) { return ('0' + n).slice(-2); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate());
  }
  /* 日時の文字列から「日」だけ取り出す（2026/09/14 18:20 → 2026-09-14） */
  function dayOf(at) {
    var t = String(at || '');
    var m = t.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    if (m) return m[1] + '-' + z2(m[2]) + '-' + z2(m[3]);
    m = t.match(/(\d{1,2})\D(\d{1,2})/);
    if (m) return z2(m[1]) + '-' + z2(m[2]);
    return t.trim();
  }
  function addDays(d, n) {
    var t = new Date(String(d) + 'T00:00:00');
    if (isNaN(t)) return d;
    t.setDate(t.getDate() + n);
    return t.getFullYear() + '-' + z2(t.getMonth() + 1) + '-' + z2(t.getDate());
  }
  function nextDay(d) { return addDays(d, 1); }
  function prevDay(d) { return addDays(d, -1); }
  /* 曜日番号（日=0）。曜日ごとの平均を出すのに使う */
  function dowOf(d) {
    var t = new Date(String(d) + 'T00:00:00');
    return isNaN(t) ? -1 : t.getDay();
  }

  /* ============================================================
     売上履歴
     ------------------------------------------------------------
     days['2026-09-14'][norm(商品名)] = { name, qty, amount }

     二重に足さないための台帳を、在庫側と同じ考え方で別に持つ：
       seen[key]        … 明細形式（伝票番号あり）の取込済み行
       totals[サマリキー] … 集計形式（伝票番号なし）の日×商品の累計
                            → 同じ日を出し直しても「増えたぶん」だけ足す

     logs[importId] に「今回足したぶん」を控えておき、
     取込を取り消したら、そのぶんだけきれいに戻せるようにする。
     ============================================================ */
  /* spans … 「この日に記録したぶんは、本当は from〜to の合計」という印。
     日付の列が無い集計CSV（月初〜今日、など）を取り込むと、売れ数が
     期間の開始日に固まって入る。印を付けておかないと、後で
     「9/1に300個売れた」と読み違えるので、必ず残す。
     日ごとの予測をちゃんと出したいなら、POSから日別で書き出すのが一番よい。 */
  function blankSales() {
    return { v: 1, days: {}, spans: {}, seen: {}, closed: {}, totals: {}, logs: {}, order: [], updatedAt: '' };
  }

  var Sales = {
    _db: null,

    /* 読み込んだ中身を持ち回っているので、localStorage を外から
       書きかえたとき（バックアップの読み込み）は捨てて読み直す。
       これをしないと、古いほうを持ったまま次の保存で上書きしてしまう。 */
    reload: function () { this._db = null; return this.load(); },

    /* broken … 端末の売上履歴が壊れていて読めないときの印（E3）。
       このときは空の履歴で始めるが、保存は一切しない（壊れた元データを
       空の履歴で上書きして消さないため）。 */
    broken: null,

    load: function () {
      if (this._db) return this._db;
      var raw = null;
      try { raw = global.localStorage.getItem(SALES_KEY); }
      catch (e) { this.broken = '売上履歴を端末から読み出せません'; this._db = blankSales(); return this._db; }
      this.broken = null;
      if (raw != null) {
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = undefined; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this._db = Object.assign(blankSales(), parsed);
          return this._db;
        }
        this.broken = '売上履歴のデータが壊れていて読めません';
      }
      this._db = blankSales();
      return this._db;
    },

    /* 保存（E3：失敗しても既存の履歴を消さない）
       ・書いたあと読み直して一致したときだけ true
       ・失敗したら false。手元の内容は捨て、次に読むときは端末に
         残っている（元の）内容から読み直す。
       ・以前は容量オーバーのときに古い日を自動で削って入れ直していたが、
         失敗しても削った状態が手元に残り、次の保存で確定して履歴が
         消えていた（E3）。いまは自動では削らない。 */
    save: function () {
      var db = this.load();
      if (this.broken) return false;
      db.updatedAt = new Date().toISOString();
      var s, ok = false;
      try {
        s = JSON.stringify(db);
        global.localStorage.setItem(SALES_KEY, s);
        ok = global.localStorage.getItem(SALES_KEY) === s;
      } catch (e) { ok = false; }
      if (!ok) this._db = null;
      return ok;
    },

    /* その取込ぶんが履歴に記録済みか（取消の控えがあるか） */
    hasLog: function (importId) { return !!this.load().logs[importId]; },

    /* SaleRecord[] を履歴に足す。
       importId … 冷凍在庫アプリの取込ID。取消のときに同じIDを渡す。
       戻り値 … { days:足した日数, items:足した商品数, qty:足した数 } */
    /* 保存期間（新しいほうから KEEP_DAYS 日分）に入らない日を返す。
       いまある日と、これから足す日を合わせて新しい順に並べ、
       KEEP_DAYS 日目より古い日が «足してもすぐ整理されて消える日»。 */
    outOfRange: function (newDays) {
      var db = this.load(), all = {};
      Object.keys(db.days).forEach(function (d) { all[d] = 1; });
      (newDays || []).forEach(function (d) { if (d) all[d] = 1; });
      var ds = Object.keys(all).sort();
      if (ds.length <= KEEP_DAYS) return [];
      var cut = ds[ds.length - KEEP_DAYS];          /* 残る日のうち一番古い日 */
      var out = {};
      (newDays || []).forEach(function (d) { if (d && d < cut) out[d] = 1; });
      return Object.keys(out).sort();
    },
    keepDays: KEEP_DAYS,

    /* 戻り値に outOfRange（保存期間外で記録しなかった日）を足した。
       保存期間外の日の行は «足してから整理して消す» のではなく、最初から足さない。
       呼ぶ側は outOfRange が空でなければ、その日のぶんの控えを消さずに残す。 */
    record: function (sales, importId, period) {
      /* 必ず端末から読み直してから足す（古い手元の内容で上書きしないため） */
      this._db = null;
      var db = this.load();
      if (this.broken) return { days: 0, items: 0, qty: 0, saved: false, broken: this.broken, outOfRange: [] };
      /* 保存期間外の日は、記録する前に見つけて外す */
      var dayOfSale = function (s) { return s.day || dayOf(s.at); };
      var want = {};
      (sales || []).forEach(function (s) { var d = dayOfSale(s); if (d) want[d] = 1; });
      var outDays = this.outOfRange(Object.keys(want));
      if (outDays.length) {
        var outSet = {}; outDays.forEach(function (d) { outSet[d] = 1; });
        sales = (sales || []).filter(function (s) { return !outSet[dayOfSale(s)]; });
      }
      var log = { at: new Date().toISOString(), lines: [], seenKeys: [], totalsPrev: {}, spanDays: [] };
      var groups = {};
      var added = { days: {}, items: {}, qty: 0 };
      var self = this;
      /* 日付の列が無く、期間が2日以上ある取込は「まとめて1日に入る」ので印を付ける */
      var lump = (period && period.from && period.to && period.from !== period.to) ? period : null;

      (sales || []).forEach(function (s) {
        var day = s.day || dayOf(s.at);
        if (!day) return;                       // 日が分からない行は履歴に残せない
        var k = norm(s.posName);
        if (!k) return;
        if (lump && !s.at && !db.spans[day]) {
          db.spans[day] = { from: lump.from, to: lump.to };
          log.spanDays.push(day);
        }

        if (s.ticket) {                          /* 明細形式：1行ずつ */
          if (db.closed[day]) return;            // 古い日：もう取り込んである
          if (db.seen[s.key]) return;
          db.seen[s.key] = day;         // 1 ではなく日。古いぶんだけ捨てられるように
          log.seenKeys.push(s.key);
          self._add(db, log, added, day, k, s.posName, num(s.qty), num(s.amount));
        } else {                                 /* 集計形式：日×商品でまとめる */
          var gk = 'S\u0001' + day + '\u0001' + k;
          var g = groups[gk] || (groups[gk] = { day: day, k: k, name: s.posName, qty: 0, amount: 0 });
          g.qty += num(s.qty);
          g.amount += num(s.amount);
        }
      });

      Object.keys(groups).forEach(function (gk) {
        var g = groups[gk];
        var done = db.totals[gk] || { qty: 0, amount: 0 };
        var dQty = g.qty - num(done.qty);
        var dAmt = g.amount - num(done.amount);
        if (dQty <= 0 && dAmt <= 0) return;      // 増えていない＝もう入っている
        if (!(gk in log.totalsPrev)) log.totalsPrev[gk] = db.totals[gk] || null;
        db.totals[gk] = { qty: g.qty, amount: g.amount };
        self._add(db, log, added, g.day, g.k, g.name, Math.max(0, dQty), Math.max(0, dAmt));
      });

      if (importId != null && (log.lines.length || log.seenKeys.length)) {
        db.logs[importId] = log;
        db.order.unshift(importId);
        this._trimLogs(db);
      }
      this.prune(KEEP_DAYS);
      /* 念のため：足した日が整理で消えていないか確かめる（消えていたら期間外として返す） */
      Object.keys(added.days).forEach(function (d) { if (!db.days[d] && outDays.indexOf(d) < 0) outDays.push(d); });
      outDays.sort();
      var saved = this.save();
      return {
        days: Object.keys(added.days).length,
        items: Object.keys(added.items).length,
        qty: added.qty,
        saved: saved,           // false … 端末の保存容量がいっぱいで残せなかった
        outOfRange: outDays     // 保存期間外で記録しなかった日（空なら全部記録した）
      };
    },

    /* 取込の取り消し。足したぶんをそのまま引いて、台帳も元に戻す */
    undo: function (importId) {
      this._db = null;
      var db = this.load();
      if (this.broken) return false;
      var log = db.logs[importId];
      if (!log) return false;

      log.lines.forEach(function (l) {
        var day = db.days[l.day];
        if (!day || !day[l.k]) return;
        day[l.k].qty -= l.qty;
        day[l.k].amount -= l.amount;
        if (day[l.k].qty <= 0 && day[l.k].amount <= 0) delete day[l.k];
        if (!Object.keys(day).length) delete db.days[l.day];
      });
      log.seenKeys.forEach(function (k) { delete db.seen[k]; });
      (log.spanDays || []).forEach(function (d) { if (!db.days[d]) delete db.spans[d]; });
      Object.keys(log.totalsPrev).forEach(function (gk) {
        if (log.totalsPrev[gk]) db.totals[gk] = log.totalsPrev[gk];
        else delete db.totals[gk];
      });

      delete db.logs[importId];
      db.order = db.order.filter(function (id) { return String(id) !== String(importId); });
      return this.save();      /* 保存できたときだけ true（E3） */
    },

    /* ---- 読み取り（Phase 1 のダッシュボードで使う） ---- */

    /* ある日の売上 … [{ name, qty, amount }] を多い順で */
    byDay: function (day) {
      var d = this.load().days[day] || {};
      return Object.keys(d).map(function (k) { return Object.assign({ key: k }, d[k]); })
        .sort(function (a, b) { return b.qty - a.qty; });
    },

    /* 期間の合計 … 商品ごとに { name, qty, amount, days } */
    range: function (from, to) {
      var db = this.load(), out = {};
      Object.keys(db.days).forEach(function (day) {
        if (from && day < from) return;
        if (to && day > to) return;
        var rows = db.days[day];
        Object.keys(rows).forEach(function (k) {
          var o = out[k] || (out[k] = { key: k, name: rows[k].name, qty: 0, amount: 0, days: 0 });
          o.name = rows[k].name || o.name;
          o.qty += num(rows[k].qty);
          o.amount += num(rows[k].amount);
          o.days++;
        });
      });
      return Object.keys(out).map(function (k) { return out[k]; })
        .sort(function (a, b) { return b.qty - a.qty; });
    },

    /* 履歴のある日を古い順で */
    days: function () { return Object.keys(this.load().days).sort(); },

    /* ためた量のめやす（設定画面に出す用） */
    stats: function () {
      var ds = this.days();
      var db = this.load();
      var qty = 0, names = {};
      Object.keys(db.days).forEach(function (d) {
        Object.keys(db.days[d]).forEach(function (k) { qty += num(db.days[d][k].qty); names[k] = 1; });
      });
      var lumped = ds.filter(function (d) { return !!db.spans[d]; }).length;
      /* «いつからいつまでのぶんか» は、日付の並びでは出せない。
         まとめて入っている日は «その1日» に1ヶ月ぶんが積まれていることがあり、
         日付の最初〜最後だけを見ると «9/1〜9/1» のように出て、
         1日ぶんしか無いように見えてしまう（実際それで読み違えた）。
         印に書いてある期間まで含めて、本当の端から端までを出す。 */
      var from = ds[0] || '', to = ds[ds.length - 1] || '';
      ds.forEach(function (d) {
        var sp = db.spans[d];
        if (!sp) return;
        if (sp.from && sp.from < from) from = sp.from;
        if (sp.to && sp.to > to) to = sp.to;
      });
      return {
        days: ds.length, from: from, to: to,
        entryFrom: ds[0] || '', entryTo: ds[ds.length - 1] || '',   // 日付そのものの端から端
        items: Object.keys(names).length, qty: qty,
        lumpedDays: lumped,                    // まとめて入っている日の数
        dailyDays: ds.length - lumped          // 日別で入っている日の数（予測に使えるのはこっち）
      };
    },

    /* その日のぶんが「まとめて入っている」なら期間を返す。日別なら null */
    spanOf: function (day) { return this.load().spans[day] || null; },

    /* 古い日を捨てる。捨てるときは「その日のぶん」を丸ごと（売上・期間の印・
       台帳・取込済みの印）まとめて捨てる。ばらばらに捨てると、日が残って
       いるのに印だけ無い状態になり、同じCSVを入れ直したときに二重に足される。 */
    prune: function (keepDays) {
      var db = this.load();
      this._closeOld(db);
      this._dropOldest(db, Object.keys(db.days).length - keepDays);

      /* 印が多すぎるときは、収まるまで古い日から丸ごと捨てる。
         印だけを間引くやり方はしない（上に書いた理由のため）。 */
      var guard = 0;
      while (Object.keys(db.seen).length > MAX_SEEN && guard++ < 200) {
        var left = Object.keys(db.days).length;
        if (left <= 1) { break; }
        if (!this._dropOldest(db, Math.max(1, Math.ceil(left / 10)))) break;
      }
      /* 日が分からない古い印（この仕組みを入れる前のもの）は最後に落とす */
      if (Object.keys(db.seen).length > MAX_SEEN) {
        Object.keys(db.seen).forEach(function (k) {
          if (typeof db.seen[k] !== 'string') delete db.seen[k];
        });
      }
    },

    /* 古い日の「伝票1行ずつの印」を「この日は取り込んだ」の1つにまとめる。
       売れ数そのものは残るので、予測には影響しない。まとめたあとで同じ日を
       入れ直すと、その日ごと飛ばす＝二重に足されない。 */
    _closeOld: function (db) {
      var ds = Object.keys(db.days).sort();
      if (!ds.length) return;
      var cut = addDays(ds[ds.length - 1], -TICKET_DAYS);   // 一番新しい日から数える
      var shut = {};
      ds.forEach(function (d) { if (d < cut && !db.closed[d]) { db.closed[d] = 1; shut[d] = 1; } });
      if (!Object.keys(shut).length) return;
      Object.keys(db.seen).forEach(function (k) {
        if (shut[db.seen[k]]) delete db.seen[k];
      });
    },

    /* 何日ぶん捨てたかを返す */
    _dropOldest: function (db, n) {
      if (!(n > 0)) return 0;
      var ds = Object.keys(db.days).sort();
      var gone = {}, cnt = 0;
      ds.slice(0, n).forEach(function (d) {
        gone[d] = 1; cnt++;
        delete db.days[d]; delete db.spans[d]; delete db.closed[d];
      });
      if (!cnt) return 0;
      Object.keys(db.totals).forEach(function (gk) {
        if (gone[gk.split('\u0001')[1]]) delete db.totals[gk];
      });
      Object.keys(db.seen).forEach(function (k) {
        if (gone[db.seen[k]]) delete db.seen[k];
      });
      return cnt;
    },

    /* いまどれくらい入っているか（設定画面で見せる） */
    usage: function () {
      var db = this.load();
      var ds = Object.keys(db.days).sort();
      var bytes = 0;
      try { bytes = (global.localStorage.getItem(SALES_KEY) || '').length; } catch (e) {}
      return {
        days: ds.length, from: ds[0] || '', to: ds[ds.length - 1] || '',
        seen: Object.keys(db.seen).length,
        closed: Object.keys(db.closed).length,   // 印をまとめ済みの日数
        ticketDays: TICKET_DAYS,
        bytes: bytes,
        keepDays: KEEP_DAYS, maxSeen: MAX_SEEN,
        full: bytes > 3.5 * 1024 * 1024        // 上限が近い
      };
    },

    /* 全部消す（設定画面から使う。取り返しがつかないので呼ぶ側で必ず確認する） */
    clear: function () {
      this._db = blankSales();
      this.broken = null;
      try { global.localStorage.removeItem(SALES_KEY); } catch (e) {}
    },

    /* ---- 内部 ---- */
    _add: function (db, log, added, day, k, name, qty, amount) {
      if (qty <= 0 && amount <= 0) return;
      var rows = db.days[day] || (db.days[day] = {});
      var row = rows[k] || (rows[k] = { name: name, qty: 0, amount: 0 });
      row.name = name || row.name;
      row.qty += qty;
      row.amount += amount;
      log.lines.push({ day: day, k: k, qty: qty, amount: amount });
      added.days[day] = 1;
      added.items[k] = 1;
      added.qty += qty;
    },
    _trimLogs: function (db, keep) {
      var n = (keep == null) ? KEEP_LOGS : keep;
      if (db.order.length <= n) return;
      db.order.slice(n).forEach(function (id) { delete db.logs[id]; });
      db.order = db.order.slice(0, n);
    }
  };

  global.KemuriCore = {
    num: num,
    norm: norm,
    todayStr: todayStr,
    dayOf: dayOf,
    addDays: addDays,
    nextDay: nextDay,
    prevDay: prevDay,
    dowOf: dowOf,
    sales: Sales,
    SALES_KEY: SALES_KEY
  };
})(typeof window !== 'undefined' ? window : this);
