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
     items[norm(名前)] = {
       name, unit, price, sale, rate, tax, status, category, note, updatedAt
     }
       price  … 1単位あたりの原価（円）。小数はそのまま持つ
       sale   … 売価（円）。無ければ null（原価だけ登録された材料など）
       tax    … 税込・税抜の別。「未統一」「税抜混在」などもそのまま持つ
       status … 計算済 / 概算 / 売価候補 / 要確認 / 要注意 など
       category … 串焼き / 一品料理 / サワー など

     ※ 画面では四捨五入して見せるが、ここには元の数値を保存する。
        丸めた値で計算を重ねると、皿数が増えたときにズレていくため。
     ============================================================ */
  var WARN_STATUS = ['要確認', '要注意'];
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

    /* 売価。未設定なら null（原価だけ登録された材料） */
    saleOf: function (name) {
      var e = this.get(name);
      return e && e.sale != null && num(e.sale) > 0 ? num(e.sale) : null;
    },
    /* 原価率（％）＝ 原価 ÷ 売価 × 100。売価が無ければ null */
    rateOf: function (name) {
      var e = this.get(name);
      if (!e) return null;
      var sale = this.saleOf(name), price = num(e.price);
      if (!(sale > 0) || !(price > 0)) return null;
      return price / sale * 100;
    },
    /* 手を入れてほしい商品か（要確認・要注意） */
    isWarn: function (e) { return !!e && WARN_STATUS.indexOf(String(e.status || '')) >= 0; },

    set: function (name, o) {
      var d = this.load(), k = norm(name);
      if (!k) return false;
      var cur = d.items[k] || {};
      var pick = function (key, fallback) {
        return (o && o[key] != null) ? String(o[key]).trim() : (cur[key] || fallback || '');
      };
      d.items[k] = {
        name: String(name).trim() || cur.name || '',
        unit: pick('unit'),
        price: o && o.price != null ? num(o.price) : num(cur.price),
        sale: (o && o.sale != null && String(o.sale) !== '')
                ? num(o.sale)
                : (cur.sale != null ? cur.sale : null),
        tax: pick('tax'),
        status: pick('status'),
        category: pick('category'),
        note: pick('note'),
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
        if (d.items[norm(name)]) updated++; else added++;   // 同じ名前は更新
        self.set(name, r);
      });
      return { added: added, updated: updated };
    },

    stats: function () {
      var a = this.all(), self = this;
      return {
        total: a.length,
        filled: a.filter(function (x) { return num(x.price) > 0; }).length,
        withSale: a.filter(function (x) { return self.saleOf(x.name) != null; }).length,
        warn: a.filter(function (x) { return self.isWarn(x); }).length,
      };
    },

    /* 手を入れてほしい商品（要確認・要注意）を、理由つきで返す */
    warnings: function () {
      var self = this;
      return this.all().filter(function (x) { return self.isWarn(x); })
        .map(function (x) {
          return { name: x.name, status: x.status, note: x.note,
                   category: x.category, rate: self.rateOf(x.name) };
        });
    },

    /* 税込・税抜がそろっていない商品の数（表示用） */
    taxGroups: function () {
      var g = {};
      this.all().forEach(function (x) {
        var t = String(x.tax || '').trim() || '（未記入）';
        g[t] = (g[t] || 0) + 1;
      });
      return Object.keys(g).sort(function (a, b) { return g[b] - g[a]; })
        .map(function (k) { return { tax: k, n: g[k] }; });
    },
  };

  /* ============================================================
     レシピマスタ
     items[norm(メニュー名)] = { name, parts:[{name, qty}] }
       parts … そのメニューを1つ出すのに使う材料と数量
     冷凍在庫アプリの「POS商品名の対応表」は、実質1対1のレシピ
     （どの在庫を、1販売でいくつ減らすか）なので、そこから作れる。
     ============================================================ */
  /* ---- 単位の合わせこみ ----
     単価は「980円/kg」、レシピは「80g」のように、単位がずれることがある。
     そのまま掛けると 980×80 = 78,400円 になってしまうので、揃えてから掛ける。
     g↔kg・ml↔L のような換算だけを扱い、知らない組み合わせは印を付けて
     画面に出す（黙って間違った原価を出さないため）。 */
  /* norm() が全角を半角に直す（ｇ→g、㎏→kg、ℓ→l）ので、半角だけ持てばよい */
  var UNIT = {
    'g': { base: 'g', k: 1 },   'kg': { base: 'g', k: 1000 },
    'グラム': { base: 'g', k: 1 }, 'キロ': { base: 'g', k: 1000 }, 'キログラム': { base: 'g', k: 1000 },
    'ml': { base: 'ml', k: 1 }, 'l': { base: 'ml', k: 1000 },
    'cc': { base: 'ml', k: 1 }, 'ミリリットル': { base: 'ml', k: 1 }, 'リットル': { base: 'ml', k: 1000 },
  };
  function unitInfo(u) { return UNIT[norm(u)] || null; }

  /* 戻り値 … { qty:換算後の数量, mismatch:単位が噛み合っていないか } */
  function convertQty(qty, fromUnit, toUnit) {
    var f = String(fromUnit || '').trim(), t = String(toUnit || '').trim();
    if (!f || !t || norm(f) === norm(t)) return { qty: qty, mismatch: false };
    var a = unitInfo(f), b = unitInfo(t);
    if (a && b && a.base === b.base) return { qty: qty * a.k / b.k, mismatch: false };
    return { qty: qty, mismatch: true };   // 「個」と「kg」など、換算できない組み合わせ
  }

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
          return {
            name: String(p.name || '').trim(),
            qty: num(p.qty) || 1,
            unit: String(p.unit || '').trim(),
          };
        }).filter(function (p) { return !!p.name; }),
      };
      this.save();
      return true;
    },
    remove: function (name) { var d = this.load(); delete d.items[norm(name)]; this.save(); },

    /* AIが整形したレシピをまとめて入れる。既にあるメニューは上書き */
    importRows: function (rows) {
      var added = 0, updated = 0, self = this;
      (rows || []).forEach(function (r) {
        var name = String(r && r.name || '').trim();
        if (!name || !Array.isArray(r.parts) || !r.parts.length) return;
        if (self.get(name)) updated++; else added++;
        self.set(name, r.parts);
      });
      return { added: added, updated: updated };
    },

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
       戻り値 … { cost, known:全部の材料に単価が入っているか,
                  mismatch:単位が噛み合わない材料があるか, parts:[...] } */
    costOf: function (menuName) {
      var r = this.get(menuName);
      if (!r || !r.parts.length) {
        var p = Costs.priceOf(menuName);
        return { cost: p, known: p > 0, mismatch: false, parts: [] };
      }
      var total = 0, known = true, mismatch = false, parts = [];
      r.parts.forEach(function (x) {
        var entry = Costs.get(x.name);
        var price = entry ? num(entry.price) : 0;
        if (!(price > 0)) known = false;
        var qty = num(x.qty) || 1;
        var c = convertQty(qty, x.unit, entry && entry.unit);
        if (c.mismatch && price > 0) mismatch = true;
        total += price * c.qty;
        parts.push({
          name: x.name, qty: qty, unit: x.unit || '',
          price: price, costUnit: (entry && entry.unit) || '',
          used: c.qty, mismatch: c.mismatch && price > 0,
        });
      });
      return { cost: total, known: known, mismatch: mismatch, parts: parts };
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
    var mismatchNames = [];   // 単位が噛み合っていないメニュー

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
      if (c.mismatch) mismatchNames.push(r.name);
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
        costMismatch: !!c.mismatch,
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
    if (mismatchNames.length) {
      caution.push('単位が噛み合っていないレシピが ' + mismatchNames.length + ' 件あります（'
        + mismatchNames.slice(0, 3).join('、') + (mismatchNames.length > 3 ? ' ほか' : '')
        + '）。材料の単位と、仕入単価の単位をそろえてください。原価がおかしな金額になります。');
    }
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

  /* ============================================================
     原価CSVの読み取り
     ------------------------------------------------------------
     形が整っているCSVは、AIを通さずここで読む。
     そのほうが正確で、費用もかからず、行数がいくら多くても切れない。
     （AIに投げると、行数ぶん返事が長くなって途中で切れる）

     見出しの名前で対応づけるので、列の並び順は問わない。
     ============================================================ */
  var CSV_COL = {
    name:     ['product_name', 'name', '商品名', '品名', 'メニュー'],
    price:    ['cost_yen', 'cost', '原価'],
    sale:     ['sale_price_yen', 'price', 'sale', '売価', '販売価格'],
    rate:     ['cost_rate_pct', 'rate', '原価率'],
    unit:     ['portion', 'unit', '単位', '分量'],
    status:   ['status', '状態'],
    tax:      ['tax_status', 'tax', '税'],
    category: ['category', '分類', 'カテゴリ'],
    note:     ['notes', 'note', '備考', 'メモ'],
  };

  function splitCsv(text) {
    /* pos-source.js があればその読み取りを使う（引用符つきCSVにも耐える） */
    if (global.KemuriPos && global.KemuriPos.parseCSV) return global.KemuriPos.parseCSV(text);
    return String(text || '').split('\n')
      .map(function (l) { return l.split(','); })
      .filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  /* 戻り値 … { rows, skipped, headerFound }
     rows[] = { name, price, sale, unit, status, tax, category, note,
                csvRate:CSVに書かれていた原価率, calcRate:計算した原価率,
                rateGap:その差, warn:要確認か } */
  function costsFromCsv(text) {
    var rows = splitCsv(text);
    if (!rows.length) return { rows: [], skipped: [], headerFound: false };

    /* 見出し行を探す（上に説明文があってもよい） */
    var headIdx = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var cells = rows[i].map(function (c) { return norm(c); });
      var c = {};
      Object.keys(CSV_COL).forEach(function (key) {
        c[key] = -1;
        CSV_COL[key].some(function (w) {
          var j = cells.indexOf(norm(w));
          if (j >= 0) { c[key] = j; return true; }
          return false;
        });
      });
      if (c.name >= 0 && c.price >= 0) { headIdx = i; cols = c; break; }
    }
    if (headIdx < 0) return { rows: [], skipped: [], headerFound: false };

    var out = [], skipped = [];
    var cell = function (r, j) { return j >= 0 && r[j] != null ? String(r[j]).trim() : ''; };

    for (var k = headIdx + 1; k < rows.length; k++) {
      var r = rows[k];
      var name = cell(r, cols.name);
      if (!name) continue;
      /* 見出しがもう一度出てきた行（貼り直しなど）は飛ばす */
      if (norm(name) === norm('product_name') || norm(name) === norm('商品名')) continue;

      var priceTxt = cell(r, cols.price);
      if (priceTxt === '') { skipped.push(name + '（原価が空）'); continue; }
      var price = num(priceTxt);

      var saleTxt = cell(r, cols.sale);
      var sale = saleTxt === '' ? null : num(saleTxt);   // 空欄なら原価だけ登録する
      if (sale != null && !(sale > 0)) sale = null;

      var csvRate = cols.rate >= 0 && cell(r, cols.rate) !== '' ? num(cell(r, cols.rate)) : null;
      var calcRate = (sale > 0 && price > 0) ? (price / sale * 100) : null;

      var status = cell(r, cols.status);
      out.push({
        name: name,
        price: price,                     // 小数はそのまま持つ
        sale: sale,
        unit: cell(r, cols.unit),
        status: status,
        tax: cell(r, cols.tax),
        category: cell(r, cols.category),
        note: cell(r, cols.note),
        csvRate: csvRate,
        calcRate: calcRate,
        /* CSVに書かれた原価率と、原価÷売価×100 がずれていないか */
        rateGap: (csvRate != null && calcRate != null)
                   ? Math.round(Math.abs(csvRate - calcRate) * 10) / 10 : null,
        warn: WARN_STATUS.indexOf(status) >= 0,
      });
    }
    return { rows: out, skipped: skipped, headerFound: true };
  }

  /* ============================================================
     日別売上（POSの「日別」集計CSV）
     ------------------------------------------------------------
     日付・天気・総売上・客数が1ファイルに日ごとで入っている。
     商品名は入っていないので在庫は動かせないが、
     «どの曜日がどれだけ忙しいか» はこれだけで出せる。
     商品別の集計（期間まとめ）と掛け合わせて、
     「金曜のもも串はだいたい何本」を見積もるのに使う。
     ============================================================ */
  var DAILY_KEY = 'kemuri_daily_v1';
  var DOW_NAME = ['日', '月', '火', '水', '木', '金', '土'];
  var MIN_DAYS = 4;   // この日数に満たない曜日は «あてにならない» 扱いにする

  var DAILY_COL = {
    day:    ['日付', '営業日', '年月日', '日'],
    weather:['天気', '天候'],
    gross:  ['総売上(税込)', '総売上（税込）', '売上(税込)', '税込売上', '総売上'],
    net:    ['総売上(税抜)', '総売上（税抜）', '売上(税抜)', '税抜売上'],
    guests: ['客計', '客数', '来客数', '人数'],
    groups: ['組計', '組数', '組'],
  };

  function blankDaily() { return { v: 1, days: {}, updatedAt: '' }; }

  var Daily = {
    _db: null,
    load: function () {
      if (this._db) return this._db;
      try {
        var raw = global.localStorage.getItem(DAILY_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          this._db = Object.assign(blankDaily(), p && typeof p === 'object' ? p : {});
          return this._db;
        }
      } catch (e) { /* 壊れていたら作り直す */ }
      this._db = blankDaily();
      return this._db;
    },
    save: function () {
      var db = this.load();
      db.updatedAt = new Date().toISOString();
      try { global.localStorage.setItem(DAILY_KEY, JSON.stringify(db)); return true; }
      catch (e) { return false; }
    },

    /* rows[] = { day, weather, gross, net, guests, groups } を入れる。
       同じ日は上書き（入れ直しても増えない）。 */
    importRows: function (rows) {
      var db = this.load(), n = 0, upd = 0;
      (rows || []).forEach(function (r) {
        if (!r || !r.day) return;
        if (db.days[r.day]) upd++; else n++;
        db.days[r.day] = {
          weather: r.weather || '',
          gross: num(r.gross), net: num(r.net),
          guests: num(r.guests), groups: num(r.groups),
        };
      });
      this.save();
      return { added: n, updated: upd, total: Object.keys(db.days).length };
    },

    all: function () { return this.load().days; },
    dayList: function () { return Object.keys(this.load().days).sort(); },
    get: function (day) { return this.load().days[day] || null; },

    stats: function () {
      var ds = this.dayList(), db = this.load();
      var g = 0, gu = 0;
      ds.forEach(function (d) { g += num(db.days[d].gross); gu += num(db.days[d].guests); });
      return {
        days: ds.length, from: ds[0] || '', to: ds[ds.length - 1] || '',
        gross: g, guests: gu,
        avgGross: ds.length ? Math.round(g / ds.length) : 0,
        avgGuests: ds.length ? Math.round(gu / ds.length * 10) / 10 : 0,
      };
    },

    /* 曜日ごとの平均。売上0の日は «休んだ日» とみなして平均から外す
       （休みを混ぜると平均が下がって、仕込みが足りなくなる）。

       営業日が MIN_DAYS 未満の曜日は «あてにならない» 印を付け、
       全体の平均（指数のものさし）からも外す。定休日にたまたま開けた
       1日のような、ならしていない数字を «その曜日の傾向» として
       見せてしまうと、仕込みを外す。 */
    dow: function () {
      var db = this.load(), acc = [];
      for (var i = 0; i < 7; i++) acc.push({ dow: i, name: DOW_NAME[i], days: 0, gross: 0, guests: 0, groups: 0, closed: 0 });
      Object.keys(db.days).forEach(function (d) {
        var r = db.days[d], i = C.dowOf(d);
        if (i == null || i < 0 || i > 6) return;
        if (!(num(r.gross) > 0)) { acc[i].closed++; return; }
        acc[i].days++; acc[i].gross += num(r.gross);
        acc[i].guests += num(r.guests); acc[i].groups += num(r.groups);
      });
      acc.forEach(function (a) { a.thin = a.days > 0 && a.days < MIN_DAYS; });

      /* ものさしは «日数がそろっている曜日» だけで作る */
      var tot = 0, cnt = 0;
      acc.forEach(function (a) { if (!a.thin) { tot += a.gross; cnt += a.days; } });
      var avgAll = cnt ? tot / cnt : 0;

      acc.forEach(function (a) {
        a.avgGross  = a.days ? Math.round(a.gross / a.days) : 0;
        a.avgGuests = a.days ? Math.round(a.guests / a.days * 10) / 10 : 0;
        a.avgGroups = a.days ? Math.round(a.groups / a.days * 10) / 10 : 0;
        /* 指数 … 全体の平均を1.00としたときの、その曜日の忙しさ。
           日数が足りない曜日は出さない（当てにならないので） */
        a.index = (avgAll && a.days && !a.thin) ? Math.round(a.avgGross / avgAll * 100) / 100 : null;
      });
      return {
        rows: acc, avgGross: Math.round(avgAll), days: cnt,
        minDays: MIN_DAYS,
        thin: acc.filter(function (a) { return a.thin; }).length,
        closed: acc.filter(function (a) { return !a.days; }).length,
      };
    },

    /* その曜日の «忙しさ指数»（全体平均＝1.00）。当てにならなければ null */
    indexOfDow: function (dow) {
      var r = this.dow().rows[dow];
      return r && r.index != null ? r.index : null;
    },

    clear: function () {
      this._db = blankDaily();
      try { global.localStorage.removeItem(DAILY_KEY); } catch (e) {}
    },
  };

  /* 「01月05日(月)」のように年が入っていない日付がある。
     かっこの曜日と実際の曜日が合う年を選ぶ＝年を当てにいく。 */
  function guessYear(parts, years) {
    var best = null;
    years.forEach(function (y) {
      var hit = 0, seen = 0;
      parts.forEach(function (p) {
        if (p.dow == null) return;
        seen++;
        var d = y + '-' + p.mm + '-' + p.dd;
        if (C.dowOf(d) === p.dow) hit++;
      });
      if (!seen) return;
      if (!best || hit > best.hit) best = { year: y, hit: hit, seen: seen };
    });
    return best;
  }

  /* 戻り値 … { rows, headerFound, year, yearGuessed, matched, total, warn } */
  function dailyFromCsv(text, forceYear) {
    var rows = splitCsv(text);
    if (!rows.length) return { rows: [], headerFound: false };

    var headIdx = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var cells = rows[i].map(function (c) { return norm(c); });
      var c = {};
      Object.keys(DAILY_COL).forEach(function (key) {
        c[key] = -1;
        DAILY_COL[key].some(function (w) {
          var j = cells.indexOf(norm(w));
          if (j >= 0) { c[key] = j; return true; }
          return false;
        });
      });
      /* 日付と、売上か客数のどちらかがあれば日別表とみなす */
      if (c.day >= 0 && (c.gross >= 0 || c.net >= 0 || c.guests >= 0)) { headIdx = i; cols = c; break; }
    }
    if (headIdx < 0) return { rows: [], headerFound: false };

    var cell = function (r, j) { return j >= 0 && r[j] != null ? String(r[j]).trim() : ''; };
    var parts = [], raw = [];

    for (var k = headIdx + 1; k < rows.length; k++) {
      var r = rows[k];
      var t = cell(r, cols.day);
      if (!t) continue;
      if (/合計|総計|平均/.test(t)) continue;          // 集計行は日ではない
      var full = t.match(/(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/);   // 年つき
      var md   = t.match(/(\d{1,2})\D{1,2}(\d{1,2})/);                  // 月日だけ
      var dowM = t.match(/[(（]\s*([日月火水木金土])\s*[)）]/);
      var dow  = dowM ? DOW_NAME.indexOf(dowM[1]) : null;
      var z2 = function (n) { return ('0' + n).slice(-2); };
      if (full) {
        parts.push({ year: full[1], mm: z2(full[2]), dd: z2(full[3]), dow: dow });
      } else if (md) {
        parts.push({ year: null, mm: z2(md[1]), dd: z2(md[2]), dow: dow });
      } else continue;
      raw.push(r);
    }
    if (!parts.length) return { rows: [], headerFound: true, year: null };

    /* 年を決める */
    var need = parts.some(function (p) { return !p.year; });
    var year = forceYear ? String(forceYear) : null, guessed = false, match = null;
    if (need && !year) {
      var now = new Date().getFullYear(), cand = [];
      for (var y = now + 1; y >= now - 4; y--) cand.push(String(y));
      match = guessYear(parts, cand);
      if (match) { year = match.year; guessed = true; }
      else year = String(now);
    }

    var out = [];
    parts.forEach(function (p, i) {
      var day = (p.year || year) + '-' + p.mm + '-' + p.dd;
      var r = raw[i];
      out.push({
        day: day,
        weather: cell(r, cols.weather),
        gross: num(cell(r, cols.gross)) || num(cell(r, cols.net)),
        net: num(cell(r, cols.net)),
        guests: num(cell(r, cols.guests)),
        groups: num(cell(r, cols.groups)),
      });
    });
    out.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });

    return {
      rows: out, headerFound: true,
      year: year, yearGuessed: guessed,
      matched: match ? match.hit : null, checked: match ? match.seen : null,
      from: out[0] ? out[0].day : '', to: out[out.length - 1] ? out[out.length - 1].day : '',
    };
  }

  /* ============================================================
     明日の出数予想
     ------------------------------------------------------------
     «その商品が、その曜日に、ふだん何個出るか» を売上履歴から直に出す。

     いままでの «曜日別の目安» は «商品のふだんの1日平均 × その曜日の
     売上倍率» だった。店全体の忙しさで一律に伸ばすやり方なので、
     「土曜だけ出る宴会向け」と「平日に出る一品」の差が消えてしまう。
     ここでは商品ごとに、その曜日の実績だけを見る。

     ・直近から数えて «その曜日で店を開けていた日» を最大 WEEKS 回ぶん
     ・売上が1件も無い日は定休日とみなして数えない（木曜が定休日のため）
     ・回数が MIN_SAMPLE に満たない曜日は数字を出さない。
       たまたま開けた日の数字を «その曜日の傾向» にすると仕込みを外す
     ・平均と一緒に最小〜最大も返す。幅を見て判断してもらうため

     在庫と突き合わせるところまでやる。
       必要な在庫 ＝ 予想の出数 × その商品の «1販売で減らす在庫数»
       足りないぶん ＝ 必要な在庫 － いまの在庫
     ============================================================ */
  var WEEKS = 8;        /* さかのぼって見る «同じ曜日» の回数 */
  var MIN_SAMPLE = 3;   /* これに満たない曜日は数字を出さない */

  function mean(a) {
    if (!a.length) return 0;
    var t = 0; a.forEach(function (x) { t += x; });
    return t / a.length;
  }

  /* その日に売上が1件でもあるか。無ければ定休日あつかい */
  function openDay(db, d) {
    var rows = db.days[d] || {};
    for (var k in rows) { if (num(rows[k].qty) > 0) return true; }
    return false;
  }
  /* «その曜日で店を開けていた日» を新しい順に最大 n 件。
     before を渡すと、その日より前だけを見る（答え合わせ用）。 */
  function sameDowDays(db, dow, n, before) {
    var all = Object.keys(db.days || {}).sort().reverse();
    var picked = [];
    for (var i = 0; i < all.length && picked.length < n; i++) {
      var d = all[i];
      if (before && d >= before) continue;
      if (C.dowOf(d) !== dow) continue;
      if (!openDay(db, d)) continue;
      picked.push(d);
    }
    return picked;
  }
  /* 選んだ日から、POS商品名ごとの «1日あたり何個» を出す。
     出ていない日は0として数える（たまに出るものを過大評価しないため）。 */
  function avgByKey(db, picked) {
    var perKey = {};
    picked.forEach(function (d) {
      var rows = db.days[d] || {};
      Object.keys(rows).forEach(function (k) {
        if (!perKey[k]) perKey[k] = { name: rows[k].name || k, qty: [] };
        perKey[k].name = rows[k].name || perKey[k].name;
      });
    });
    Object.keys(perKey).forEach(function (k) {
      perKey[k].qty = picked.map(function (d) {
        var r = (db.days[d] || {})[k];
        return r ? num(r.qty) : 0;
      });
      perKey[k].avg = mean(perKey[k].qty);
    });
    return perKey;
  }
  /* その日に実際に出た数（POS商品名ごと） */
  function actualByKey(db, day) {
    var rows = db.days[day] || {}, out = {};
    Object.keys(rows).forEach(function (k) { out[k] = num(rows[k].qty); });
    return out;
  }

  /* 商品ごとの «その日の予想» を、在庫商品ごとにまとめて突き合わせる。
     精密な出し方でも、ざっくりした出し方でも、ここから先は同じ計算。
       est[POSキー] = { name, avg, qty:[日ごとの実績] または null }
     qty があるときだけ «幅»（いちばん少ない日〜多い日）を出す。 */
  function matchStock(est, picked) {
    var byItem = {}, unmapped = [];
    Object.keys(est).forEach(function (k) {
      var e = est[k];
      if (!(e.avg > 0)) return;
      var it = Stock.itemForPos(e.name) || Stock.itemForPos(k);
      if (!it) { unmapped.push({ name: e.name, avg: Math.round(e.avg * 10) / 10 }); return; }
      var b = byItem[it.id] || (byItem[it.id] = {
        id: it.id, name: it.name, unit: it.unit || '個',
        per: num(it.per) || 1, stock: num(it.stock), min: num(it.min),
        sell: 0, lo: null, hi: null, keys: []
      });
      b.sell += e.avg;
      b.keys.push(k);
    });
    /* 幅は «その在庫を使うPOS名ぜんぶ» を日ごとに足してから取る。
       商品ごとに別々の最小・最大を足すと、ありえない幅になるため。 */
    if (picked && picked.length) {
      Object.keys(byItem).forEach(function (id) {
        var b = byItem[id];
        var totals = picked.map(function (d, idx) {
          var t = 0;
          b.keys.forEach(function (k) { t += (est[k].qty ? est[k].qty[idx] : 0); });
          return t;
        });
        b.lo = Math.min.apply(null, totals);
        b.hi = Math.max.apply(null, totals);
      });
    }
    var rows = Object.keys(byItem).map(function (id) {
      var b = byItem[id];
      var sell = Math.round(b.sell * 10) / 10;
      var need = Math.round(sell * b.per * 10) / 10;       /* 必要な在庫 */
      var short = Math.round(Math.max(0, need - b.stock) * 10) / 10;
      return {
        id: b.id, name: b.name, unit: b.unit, per: b.per,
        sell: sell, lo: b.lo, hi: b.hi,
        need: need, stock: b.stock, min: b.min, short: short, ok: short <= 0
      };
    });
    /* 足りないものが先。同じなら必要量が多いほう */
    rows.sort(function (a, b) { return (b.short - a.short) || (b.need - a.need); });
    return { rows: rows, unmapped: unmapped.sort(function (a, b) { return b.avg - a.avg; }).slice(0, 10) };
  }

  /* target … 'YYYY-MM-DD'。省略したら明日

     出し方は2通り。データの揃い具合で自動的に決まる。
       'dow'   … その商品の、その曜日の実績だけを見る（精密）
       'rough' … 商品のふだんの1日平均 × その曜日の忙しさ（大まか）

     商品別の売上を «期間まるごと» で取り込むと、全部が期間の開始日に
     積まれるので «その曜日の実績» が作れない。それでも日別売上
     （総額）が貯まっていれば曜日の忙しさは分かるので、そちらを使って
     とりあえずの目安を出す。日別の商品データが貯まれば精密に切り替わる。 */
  function forecast(target) {
    var day = target || C.nextDay(C.todayStr());
    var dow = C.dowOf(day);
    var sales = global.KemuriCore && global.KemuriCore.sales;
    var out = {
      day: day, dow: dow, dowName: DOW_NAME[dow],
      mode: '', sample: 0, need: MIN_SAMPLE, days: [], rows: [], unmapped: [],
      hasStock: false, closedDow: false, dowIndex: null, dowDays: 0, dowThin: false
    };
    out.hasStock = Stock.items().length > 0;
    if (!sales) return out;
    var db = sales.load();

    /* その曜日に店を開けているかは «日別売上» で見る。
       商品別がまとめ取込だと、どの曜日も «実績なし» に見えてしまうため。 */
    var dr = Daily.dow().rows[dow] || null;
    out.dowDays  = dr ? dr.days : 0;
    out.dowIndex = dr ? dr.index : null;
    out.dowThin  = !!(dr && dr.thin);
    /* 日別売上がまだ無いときは、商品別の履歴で判断するしかない */
    var hasDaily = Object.keys(Daily.load().days || {}).length > 0;

    var picked = sameDowDays(db, dow, WEEKS, target ? day : null);
    out.days = picked.slice().reverse();
    out.sample = picked.length;
    out.need = Math.max(0, MIN_SAMPLE - picked.length);

    out.closedDow = hasDaily ? (out.dowDays === 0) : (picked.length === 0);
    if (out.closedDow) return out;

    if (picked.length >= MIN_SAMPLE) {
      /* ---- 精密：その商品の、その曜日の実績だけ ---- */
      var perKey = avgByKey(db, picked);
      var m = matchStock(perKey, picked);
      out.mode = 'dow'; out.rows = m.rows; out.unmapped = m.unmapped;
      return out;
    }

    /* ---- 大まか：ふだんの1日平均 × その曜日の忙しさ ---- */
    if (out.dowIndex == null) return out;          /* 忙しさも出せない＝まだ何も言えない */
    var cov = coverage();
    var tot = sales.range();                       /* POS名ごとの期間合計 */
    if (!tot.length) return out;
    var est = {};
    tot.forEach(function (r) {
      est[r.key] = { name: r.name, avg: (num(r.qty) / cov.days) * out.dowIndex, qty: null };
    });
    var m2 = matchStock(est, null);
    out.mode = 'rough'; out.rows = m2.rows; out.unmapped = m2.unmapped;
    out.covDays = cov.days;
    return out;
  }

  /* ============================================================
     予想の答え合わせ（バックテスト）
     ------------------------------------------------------------
     過去の営業日を1日ずつ «その日の前日までのデータだけ» で予想し直し、
     実際に出た数と比べる。当てにしていい数字かどうかを、思い込みでなく
     実績で見るため。

     出すもの
       ・ズレ … |予想 － 実際| の平均（何個ずれたか）
       ・誤差率 … ズレ ÷ 実際の平均（何割ずれたか）
       ・足りなかった回数 … 実際 > 予想。品切れにつながる側のはずれ
     商品ごとにも出す。よく当たる商品は任せられるし、外れやすい商品は
     自分で判断する、という使い分けができる。
     ============================================================ */
  function backtest(opts) {
    var o = opts || {};
    var testDays = o.days || 40;        /* さかのぼって試す営業日の数 */
    var sales = global.KemuriCore && global.KemuriCore.sales;
    var out = { tested: 0, from: '', to: '', pairs: 0, mae: 0, rate: null,
                short: 0, over: 0, rows: [], skipped: 0 };
    if (!sales) return out;
    var db = sales.load();

    var all = Object.keys(db.days || {}).sort();
    var open = all.filter(function (d) { return openDay(db, d); });
    var targets = open.slice(-testDays);
    if (!targets.length) return out;

    /* 在庫商品ごとにまとめる。POS名が複数ぶら下がることがあるため */
    var itemOf = {};                    /* POSキー -> 在庫商品（null もキャッシュ） */
    function item(k, name) {
      if (!(k in itemOf)) itemOf[k] = Stock.itemForPos(name) || Stock.itemForPos(k) || null;
      return itemOf[k];
    }

    var acc = {};                       /* 在庫商品ごとの集計 */
    targets.forEach(function (day) {
      var picked = sameDowDays(db, C.dowOf(day), WEEKS, day);
      if (picked.length < MIN_SAMPLE) { out.skipped++; return; }   /* その日は予想できなかった */
      out.tested++;
      if (!out.from) out.from = day;
      out.to = day;

      var perKey = avgByKey(db, picked);
      var real = actualByKey(db, day);

      /* その日ぶんを在庫商品ごとに寄せる */
      var pred = {}, act = {};
      Object.keys(perKey).forEach(function (k) {
        var it = item(k, perKey[k].name);
        if (!it) return;
        pred[it.id] = (pred[it.id] || 0) + perKey[k].avg;
      });
      Object.keys(real).forEach(function (k) {
        var nm = (db.days[day][k] || {}).name || k;
        var it = item(k, nm);
        if (!it) return;
        act[it.id] = (act[it.id] || 0) + real[k];
      });

      var ids = {};
      Object.keys(pred).forEach(function (id) { ids[id] = 1; });
      Object.keys(act).forEach(function (id) { ids[id] = 1; });
      Object.keys(ids).forEach(function (id) {
        var p = pred[id] || 0, a = act[id] || 0;
        if (p <= 0 && a <= 0) return;
        var st = Stock.items().filter(function (x) { return String(x.id) === String(id); })[0];
        var b = acc[id] || (acc[id] = { id: id, name: st ? st.name : id,
                                        unit: (st && st.unit) || '個',
                                        n: 0, sumAbs: 0, sumAct: 0, short: 0, over: 0 });
        b.n++;
        b.sumAbs += Math.abs(a - p);
        b.sumAct += a;
        if (a > p) b.short++; else if (p > a) b.over++;
      });
    });

    var rows = Object.keys(acc).map(function (id) {
      var b = acc[id];
      var mae = b.sumAbs / b.n;
      var avgAct = b.sumAct / b.n;
      return {
        id: b.id, name: b.name, unit: b.unit, n: b.n,
        mae: Math.round(mae * 10) / 10,
        avg: Math.round(avgAct * 10) / 10,
        rate: avgAct > 0 ? Math.round((mae / avgAct) * 100) : null,
        short: b.short, over: b.over
      };
    });
    /* よく出るものから。まず見たいのは «数の多い商品が当たっているか» なので */
    rows.sort(function (a, b) { return b.avg - a.avg; });

    var sumAbs = 0, sumAct = 0, n = 0, sh = 0, ov = 0;
    Object.keys(acc).forEach(function (id) {
      var b = acc[id];
      sumAbs += b.sumAbs; sumAct += b.sumAct; n += b.n; sh += b.short; ov += b.over;
    });
    out.pairs = n;
    out.mae = n ? Math.round((sumAbs / n) * 10) / 10 : 0;
    out.rate = sumAct > 0 ? Math.round((sumAbs / sumAct) * 100) : null;
    out.short = sh;
    out.over = ov;
    out.rows = rows;
    return out;
  }

  global.KemuriData = {
    forecast: forecast,
    backtest: backtest,
    FORECAST_WEEKS: WEEKS,
    FORECAST_MIN: MIN_SAMPLE,
    costs: Costs,
    daily: Daily,
    dailyFromCsv: dailyFromCsv,
    DAILY_KEY: DAILY_KEY,
    costsFromCsv: costsFromCsv,
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
