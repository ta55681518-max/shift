/* ============================================================
   串焼KEMURI屋 原価・レシピ・分析  kemuri-data.js
   ------------------------------------------------------------
   ・原価マスタ   … localStorage['kemuri_costs_v1']
   ・レシピマスタ … localStorage['kemuri_recipes_v1']
   ・分析         … 売上履歴(kemuri-core.js) ＋ 冷凍在庫 から計算

   【考え方】
   数字はぜんぶここ（ふつうのJS）で計算する。AIには計算させない。
   AIには「計算済みの数字を見て、気づいたことを日本語で書く」役だけ
   やってもらう。そうすればAPIが落ちていても数字は出るし、
   数字が勝手に作られることもない。

   kemuri-core.js より後に読み込むこと。
   ============================================================ */
(function (global) {
  'use strict';

  var C = global.KemuriCore;
  var num = C.num, norm = C.norm;

  var COST_KEY   = 'kemuri_costs_v1';
  var RECIPE_KEY = 'kemuri_recipes_v1';
  var REITOU_KEY = 'kemuri_reitou_v1';

  function readLS(key, fallback) {
    try {
      var r = global.localStorage.getItem(key);
      if (r) { var o = JSON.parse(r); if (o && typeof o === 'object') return o; }
    } catch (e) {}
    return fallback;
  }
  function writeLS(key, obj) {
    try { global.localStorage.setItem(key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }
  function nowISO() { return new Date().toISOString(); }

  /* ============================================================
     原価マスタ
     items[norm(名前)] = { name, unit, price, note, updatedAt }
       price … 1単位あたりの仕入値（円）
     ============================================================ */
  var Costs = {
    _db: null,
    load: function () {
      if (!this._db) this._db = readLS(COST_KEY, { v: 1, items: {}, updatedAt: '' });
      if (!this._db.items) this._db.items = {};
      return this._db;
    },
    save: function () { var d = this.load(); d.updatedAt = nowISO(); return writeLS(COST_KEY, d); },

    all: function () {
      var it = this.load().items;
      return Object.keys(it).map(function (k) { return Object.assign({ key: k }, it[k]); })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ja'); });
    },
    get: function (name) { return this.load().items[norm(name)] || null; },
    /* 1単位あたりの仕入値。未入力なら 0 */
    priceOf: function (name) { var e = this.get(name); return e ? num(e.price) : 0; },

    set: function (name, o) {
      var d = this.load(), k = norm(name);
      if (!k) return false;
      var cur = d.items[k] || {};
      d.items[k] = {
        name: String(name).trim() || cur.name || '',
        unit: o && o.unit != null ? String(o.unit).trim() : (cur.unit || ''),
        price: o && o.price != null ? num(o.price) : num(cur.price),
        note: o && o.note != null ? String(o.note).trim() : (cur.note || ''),
        updatedAt: nowISO(),
      };
      this.save();
      return true;
    },
    remove: function (name) { var d = this.load(); delete d.items[norm(name)]; this.save(); },

    /* AIが整形した行をまとめて入れる。既にある商品は上書き。
       戻り値 … { added, updated } */
    importRows: function (rows) {
      var d = this.load(), added = 0, updated = 0, self = this;
      (rows || []).forEach(function (r) {
        var name = String(r && r.name || '').trim();
        if (!name) return;
        var k = norm(name);
        if (d.items[k]) updated++; else added++;
        d.items[k] = {
          name: name,
          unit: String(r.unit || '').trim(),
          price: num(r.price),
          note: String(r.note || '').trim(),
          updatedAt: nowISO(),
        };
      });
      this.save();
      return { added: added, updated: updated };
    },

    stats: function () {
      var a = this.all();
      return { total: a.length, filled: a.filter(function (x) { return num(x.price) > 0; }).length };
    },
  };

  /* ============================================================
     レシピマスタ
     items[norm(メニュー名)] = { name, parts:[{name, qty}] }
       parts … そのメニューを1つ出すのに使う材料と数量
     冷凍在庫アプリの「POS商品名の対応表」は、実質1対1のレシピ
     （どの在庫を、1販売でいくつ減らすか）なので、そこから作れる。
     ============================================================ */
  var Recipes = {
    _db: null,
    load: function () {
      if (!this._db) this._db = readLS(RECIPE_KEY, { v: 1, items: {}, seeded: 0, updatedAt: '' });
      if (!this._db.items) this._db.items = {};
      return this._db;
    },
    save: function () { var d = this.load(); d.updatedAt = nowISO(); return writeLS(RECIPE_KEY, d); },

    all: function () {
      var it = this.load().items;
      return Object.keys(it).map(function (k) { return Object.assign({ key: k }, it[k]); })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ja'); });
    },
    get: function (name) { return this.load().items[norm(name)] || null; },
    set: function (name, parts) {
      var d = this.load(), k = norm(name);
      if (!k) return false;
      d.items[k] = {
        name: String(name).trim(),
        parts: (parts || []).map(function (p) {
          return { name: String(p.name || '').trim(), qty: num(p.qty) || 1 };
        }).filter(function (p) { return !!p.name; }),
      };
      this.save();
      return true;
    },
    remove: function (name) { var d = this.load(); delete d.items[norm(name)]; this.save(); },

    /* 冷凍在庫の対応表から、1対1のレシピを作る（既にあるものは触らない）。
       戻り値 … 追加した件数 */
    seedFromStock: function () {
      var z = readLS(REITOU_KEY, null);
      if (!z || !Array.isArray(z.items)) return 0;
      var byId = {};
      z.items.forEach(function (i) { byId[i.id] = i; });
      var d = this.load(), n = 0;
      Object.keys(z.map || {}).forEach(function (k) {
        var m = z.map[k];
        if (!m || m.item === '__skip__') return;
        var it = byId[m.item];
        if (!it) return;
        var label = String(m.label || it.name).trim();
        var key = norm(label);
        if (!key || d.items[key]) return;
        d.items[key] = { name: label, parts: [{ name: it.name, qty: num(it.per) || 1 }] };
        n++;
      });
      if (n) { d.seeded = 1; this.save(); }
      return n;
    },

    /* そのメニュー1つぶんの原価。レシピが無ければ、同じ名前の単価を直接見る。
       戻り値 … { cost, known:全部の材料に単価が入っているか, parts:[{name,qty,price}] } */
    costOf: function (menuName) {
      var r = this.get(menuName);
      if (!r || !r.parts.length) {
        var p = Costs.priceOf(menuName);
        return { cost: p, known: p > 0, parts: [] };
      }
      var total = 0, known = true, parts = [];
      r.parts.forEach(function (x) {
        var price = Costs.priceOf(x.name);
        if (!(price > 0)) known = false;
        total += price * (num(x.qty) || 1);
        parts.push({ name: x.name, qty: num(x.qty) || 1, price: price });
      });
      return { cost: total, known: known, parts: parts };
    },
  };

  /* ============================================================
     冷凍在庫アプリのデータを読むだけの窓口（書き込みはしない）
     ============================================================ */
  var Stock = {
    db: function () { return readLS(REITOU_KEY, null); },
    items: function () {
      var z = this.db();
      return (z && Array.isArray(z.items)) ? z.items : [];
    },
    /* POS商品名 → 在庫商品。対応表をそのまま使う */
    itemForPos: function (posName) {
      var z = this.db(); if (!z) return null;
      var m = (z.map || {})[norm(posName)];
      if (!m || m.item === '__skip__') return null;
      var list = z.items || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === m.item) return list[i];
      return null;
    },
  };

  /* ============================================================
     期間の数え方
     日付の列が無いCSVは、売れ数が期間の開始日に固まって入る。
     その日には印（span）が付いているので、印のある日は
     「その期間の日数」として数える。
     ============================================================ */
  function daysBetween(a, b) {
    var t1 = new Date(String(a) + 'T00:00:00'), t2 = new Date(String(b) + 'T00:00:00');
    if (isNaN(t1) || isNaN(t2)) return 0;
    return Math.round((t2 - t1) / 86400000);
  }

  function coverage(from, to) {
    var days = C.sales.days().filter(function (d) {
      return (!from || d >= from) && (!to || d <= to);
    });
    var n = 0, lumped = 0;
    days.forEach(function (d) {
      var sp = C.sales.spanOf(d);
      if (sp) { n += Math.max(1, daysBetween(sp.from, sp.to) + 1); lumped++; }
      else n += 1;
    });
    return { days: Math.max(1, n), entries: days.length, lumped: lumped, list: days };
  }

  /* ============================================================
     分析（ぜんぶここで計算する）
     ============================================================ */
  function analyze(opt) {
    opt = opt || {};
    var from = opt.from || '', to = opt.to || '';
    var cov = coverage(from, to);
    var rows = C.sales.range(from, to);

    var totalQty = 0, totalAmount = 0, totalCost = 0, costKnownAmount = 0;

    /* 1つの在庫商品に、POSの商品名が複数ぶら下がることがある
       （例：「鶏みそ串カツ」と「串カツおろしポン酢」→ どちらも在庫は「串カツ」）。
       残り日数は、その在庫を使う売上を全部足してから計算しないと、
       減りを少なく見積もってしまう。 */
    var salesPerDayOf = {};   // 在庫商品名 -> 1日あたりの販売数（合計）
    rows.forEach(function (r) {
      var it = Stock.itemForPos(r.name);
      if (!it) return;
      salesPerDayOf[it.name] = (salesPerDayOf[it.name] || 0) + num(r.qty) / cov.days;
    });
    function daysLeftOf(it) {
      var sales = salesPerDayOf[it.name] || 0;
      var perDay = sales * (num(it.per) || 1);          // 1日に減る在庫の数
      if (!(perDay > 0)) return null;
      return Math.round((num(it.stock) / perDay) * 10) / 10;
    }

    var products = rows.map(function (r) {
      var qty = num(r.qty), amount = num(r.amount);
      var unitPrice = qty > 0 ? amount / qty : 0;
      var c = Recipes.costOf(r.name);
      var cost = c.cost;
      var costRate = (c.known && unitPrice > 0) ? (cost / unitPrice) : null;
      var perDay = qty / cov.days;

      var it = Stock.itemForPos(r.name);
      var daysLeft = it ? daysLeftOf(it) : null;

      totalQty += qty;
      totalAmount += amount;
      if (c.known) { totalCost += cost * qty; costKnownAmount += amount; }

      return {
        name: r.name,
        qty: qty,
        amount: Math.round(amount),
        unitPrice: Math.round(unitPrice),
        cost: c.known ? Math.round(cost) : null,
        costRate: costRate != null ? Math.round(costRate * 1000) / 10 : null,  // %
        perDay: Math.round(perDay * 10) / 10,
        stock: it ? num(it.stock) : null,
        stockName: it ? it.name : null,
        daysLeft: daysLeft,
      };
    });

    /* 発注ライン以下・在庫が数日でなくなりそうな商品 */
    var lowStock = Stock.items().map(function (it) {
      var perDay = (salesPerDayOf[it.name] || 0) * (num(it.per) || 1);
      return {
        name: it.name,
        stock: num(it.stock),
        min: num(it.min),
        perDay: Math.round(perDay * 10) / 10,
        daysLeft: daysLeftOf(it),
        under: num(it.stock) <= num(it.min),
      };
    }).filter(function (x) {
      return x.under || (x.daysLeft != null && x.daysLeft <= 3);
    }).sort(function (a, b) {
      var A = a.daysLeft == null ? 999 : a.daysLeft, B = b.daysLeft == null ? 999 : b.daysLeft;
      return A - B;
    });

    var caution = [];
    if (cov.lumped) {
      caution.push('取り込んだ売上のうち ' + cov.lumped + ' 件は、日付の列が無いCSVのため期間の開始日にまとめて入っています。'
        + '曜日ごとの傾向は出せません（POSから日別で書き出すと出せるようになります）。');
    }
    if (cov.days < 7) caution.push('データの期間が ' + cov.days + ' 日ぶんしかありません。傾向を見るには短すぎます。');
    var cs = Costs.stats();
    if (cs.filled === 0) caution.push('仕入単価がまだ1件も入っていないので、原価率は出せません。');
    else if (cs.filled < cs.total) caution.push('仕入単価が入っていない商品が ' + (cs.total - cs.filled) + ' 件あります。');

    return {
      period: { from: from || (cov.list[0] || ''), to: to || (cov.list[cov.list.length - 1] || ''), days: cov.days },
      totals: {
        qty: totalQty,
        amount: Math.round(totalAmount),
        perDay: Math.round(totalAmount / cov.days),
        costRate: costKnownAmount > 0 ? Math.round((totalCost / costKnownAmount) * 1000) / 10 : null,
        costCoverage: totalAmount > 0 ? Math.round((costKnownAmount / totalAmount) * 100) : 0,
      },
      products: products,
      lowStock: lowStock,
      caution: caution,
    };
  }

  /* AIに渡す用に小さくする（商品は上位だけ、余計な項目は落とす） */
  function forAI(a, limit) {
    limit = limit || 40;
    var top = a.products.slice(0, limit).map(function (p) {
      var o = { 商品: p.name, 出数: p.qty, 売上: p.amount, 単価: p.unitPrice, '1日あたり': p.perDay };
      if (p.costRate != null) { o.原価 = p.cost; o['原価率%'] = p.costRate; }
      if (p.daysLeft != null) { o.在庫 = p.stock; o['残り日数'] = p.daysLeft; }
      return o;
    });
    return {
      期間: a.period.from + '〜' + a.period.to + '（' + a.period.days + '日ぶん）',
      合計: { 出数: a.totals.qty, 売上: a.totals.amount, '1日平均売上': a.totals.perDay, '全体の原価率%': a.totals.costRate },
      商品: top,
      在庫が少ない: a.lowStock.slice(0, 15),
      注意: a.caution,
    };
  }

  global.KemuriData = {
    costs: Costs,
    recipes: Recipes,
    stock: Stock,
    analyze: analyze,
    forAI: forAI,
    coverage: coverage,
    daysBetween: daysBetween,
    COST_KEY: COST_KEY,
    RECIPE_KEY: RECIPE_KEY,
  };
})(typeof window !== 'undefined' ? window : this);
