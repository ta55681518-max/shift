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
       （休みを混ぜると平均が下がって、仕込みが足りなくなる）。 */
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
      var tot = 0, cnt = 0;
      acc.forEach(function (a) { tot += a.gross; cnt += a.days; });
      var avgAll = cnt ? tot / cnt : 0;
      acc.forEach(function (a) {
        a.avgGross  = a.days ? Math.round(a.gross / a.days) : 0;
        a.avgGuests = a.days ? Math.round(a.guests / a.days * 10) / 10 : 0;
        a.avgGroups = a.days ? Math.round(a.groups / a.days * 10) / 10 : 0;
        /* 指数 … 全体の平均を1.00としたときの、その曜日の忙しさ */
        a.index = avgAll ? Math.round(a.avgGross / avgAll * 100) / 100 : 0;
      });
      return { rows: acc, avgGross: Math.round(avgAll), days: cnt };
    },

    /* その曜日の «忙しさ指数»（全体平均＝1.00）。データが無ければ null */
    indexOfDow: function (dow) {
      var r = this.dow().rows[dow];
      return r && r.days ? r.index : null;
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

  global.KemuriData = {
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
