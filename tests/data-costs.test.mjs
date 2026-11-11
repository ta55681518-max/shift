/* 原価・レシピ・日別売上・予測（kemuri-data.js）の振るまいを固定する。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFull, plain } from './helpers/env.mjs';

describe('原価マスタ', () => {
  test('登録と原価率の計算', () => {
    const { KemuriData } = loadFull();
    const C = KemuriData.costs;
    C.set('もも', { price: 84.38, sale: 220, unit: '1本', status: '計算済', category: '串焼き', tax: '未統一' });

    assert.equal(C.priceOf('もも'), 84.38, '小数が丸められている');
    assert.equal(C.saleOf('もも'), 220);
    assert.equal(Math.round(C.rateOf('もも') * 10) / 10, 38.4, '原価率が合わない');
    assert.equal(C.priceOf('存在しない'), 0);
    assert.equal(C.rateOf('存在しない'), null);
  });

  test('売価が無ければ原価率は出さない（0除算しない）', () => {
    const { KemuriData } = loadFull();
    const C = KemuriData.costs;
    C.set('レタス', { price: 120 });
    assert.equal(C.saleOf('レタス'), null);
    assert.equal(C.rateOf('レタス'), null, '売価なしで原価率を出した');
  });

  test('要確認・要注意に印が付く', () => {
    const { KemuriData } = loadFull();
    const C = KemuriData.costs;
    C.set('あやしい', { price: 100, sale: 300, status: '要確認', note: '単位不明' });
    assert.equal(C.isWarn(C.get('あやしい')), true);
    assert.equal(plain(C.warnings()).length, 1);
    assert.equal(C.stats().warn, 1);
  });

  test('CSVから読み取れる（AIを通さない）', () => {
    const { KemuriData } = loadFull();
    const csv = [
      'category,product_name,cost_yen,sale_price_yen,cost_rate_pct,portion,status,tax_status,notes',
      '串焼き,もも,84.38,220,38.4,1本,計算済,未統一,1kg1350円・16本取り',
      '串焼き,ねぎま,90,220,40.9,1本,計算済,未統一,',
      '一品料理,だめな行,,300,,,,,',
    ].join('\n');
    const r = KemuriData.costsFromCsv(csv);
    assert.equal(r.headerFound, true, '見出しが見つからない');
    assert.equal(plain(r.rows).length, 2, '読み取れた行数が合わない');
    assert.equal(plain(r.skipped).length, 1, '原価が空の行が skipped に入っていない');
    assert.equal(r.rows[0].price, 84.38);
    assert.equal(r.rows[0].category, '串焼き');
  });

  test('CSVの原価率と計算値のズレを検出する', () => {
    const { KemuriData } = loadFull();
    const csv = [
      'product_name,cost_yen,sale_price_yen,cost_rate_pct',
      'うそ原価率,100,200,99',
    ].join('\n');
    const r = KemuriData.costsFromCsv(csv);
    assert.equal(r.rows[0].csvRate, 99);
    assert.equal(r.rows[0].calcRate, 50);
    assert.equal(r.rows[0].rateGap, 49, '原価率のズレが検出されていない');
  });

  test('importRows でまとめて入る', () => {
    const { KemuriData } = loadFull();
    const r = KemuriData.costs.importRows([
      { name: 'もも', price: 84, sale: 220 },
      { name: 'ねぎま', price: 90, sale: 220 },
      { name: 'もも', price: 85, sale: 220 },   // 同名は更新
    ]);
    assert.equal(r.added, 2);
    assert.equal(r.updated, 1);
    assert.equal(KemuriData.costs.priceOf('もも'), 85, '更新されていない');
  });
});

describe('レシピと単位換算', () => {
  test('g↔kg を揃えてから掛ける（78,400円事故の防止）', () => {
    const { KemuriData } = loadFull();
    KemuriData.costs.set('鶏もも肉', { price: 980, unit: 'kg' });
    KemuriData.recipes.set('もも串', [{ name: '鶏もも肉', qty: 80, unit: 'g' }]);

    const c = KemuriData.recipes.costOf('もも串');
    assert.equal(c.known, true, '単価が引けていない');
    assert.equal(c.mismatch, false, '換算できるのに単位ずれ扱いされた');
    assert.equal(Math.round(c.cost * 100) / 100, 78.4, '単位換算が効いていない（980×80になっていないか）');
  });

  test('換算できない組み合わせは mismatch の印を付ける（黙って間違えない）', () => {
    const { KemuriData } = loadFull();
    KemuriData.costs.set('レタス', { price: 200, unit: '個' });
    KemuriData.recipes.set('サラダ', [{ name: 'レタス', qty: 80, unit: 'g' }]);

    const c = KemuriData.recipes.costOf('サラダ');
    assert.equal(c.mismatch, true, '「個」と「g」のズレが検出されていない');
  });

  test('レシピが無ければ同名の単価を直接見る', () => {
    const { KemuriData } = loadFull();
    KemuriData.costs.set('枝豆', { price: 150, sale: 400 });
    const c = KemuriData.recipes.costOf('枝豆');
    assert.equal(c.cost, 150);
    assert.equal(plain(c.parts).length, 0);
  });

  test('単価未入力の材料があれば known:false', () => {
    const { KemuriData } = loadFull();
    KemuriData.recipes.set('謎メニュー', [{ name: '未登録の材料', qty: 1 }]);
    assert.equal(KemuriData.recipes.costOf('謎メニュー').known, false);
  });
});

describe('日別売上', () => {
  test('importRows の戻り値に saved がある（reitou.html が見ている）', () => {
    const { KemuriData } = loadFull();
    const r = KemuriData.daily.importRows([
      { day: '2026-11-01', weather: '晴', gross: 103220, net: 93897, guests: 13, groups: 12 },
    ]);
    assert.equal(r.added, 1);
    assert.equal(r.saved, true, 'saved キーが無い／false（reitou.html の警告が壊れる）');
    assert.equal(r.total, 1);
  });

  test('保存できなかったら saved:false を返す', () => {
    const { KemuriData } = loadFull({ mode: 'quota' });
    const r = KemuriData.daily.importRows([{ day: '2026-11-01', gross: 1000 }]);
    assert.equal(r.saved, false, '容量オーバーなのに saved:true');
  });

  test('同じ日は上書き（入れ直しても増えない）', () => {
    const { KemuriData } = loadFull();
    KemuriData.daily.importRows([{ day: '2026-11-01', gross: 100 }]);
    const r = KemuriData.daily.importRows([{ day: '2026-11-01', gross: 200 }]);
    assert.equal(r.added, 0);
    assert.equal(r.updated, 1);
    assert.equal(KemuriData.daily.get('2026-11-01').gross, 200);
  });

  test('売上0の日は「休み」として平均から外す', () => {
    const { KemuriData } = loadFull();
    KemuriData.daily.importRows([
      { day: '2026-11-02', gross: 100000, guests: 10 },   // 月
      { day: '2026-11-03', gross: 0, guests: 0 },          // 火（休み）
      { day: '2026-11-04', gross: 200000, guests: 20 },    // 水
    ]);
    const st = KemuriData.daily.stats();
    assert.equal(st.days, 3);
    assert.equal(st.openDays, 2, '営業日の数が合わない');
    assert.equal(st.closedDays, 1);
    assert.equal(st.avgGross, 150000, '休みを混ぜて平均が下がっている');
  });

  test('CSVの年を曜日から推測する', () => {
    const { KemuriData } = loadFull();
    /* 2026-01-05 は月曜 */
    const csv = [
      '日付,天気,総売上(税抜),総売上(税込),客計',
      '01月05日(月),,93897,103220,13',
    ].join('\n');
    const r = KemuriData.dailyFromCsv(csv);
    assert.equal(r.headerFound, true);
    assert.equal(plain(r.rows).length, 1);
    assert.equal(r.yearGuessed, true, '年を推測した印が無い');
    assert.equal(r.rows[0].day, '2026-01-05', '曜日から年を当てられていない');
    assert.equal(r.rows[0].gross, 103220, '税込を優先していない');
  });

  test('日別売上のCSVに見えないものは headerFound:false', () => {
    const { KemuriData } = loadFull();
    const r = KemuriData.dailyFromCsv('商品名,出数\nポテトフライ,36');
    assert.equal(r.headerFound, false, '商品別CSVを日別として受け入れた');
  });

  test('曜日ごとの指数：日数が足りない曜日は出さない', () => {
    const { KemuriData } = loadFull();
    const rows = [];
    /* 月曜を5回、金曜を1回だけ入れる */
    for (const d of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']) {
      rows.push({ day: d, gross: 100000, guests: 10 });
    }
    rows.push({ day: '2026-11-06', gross: 500000, guests: 50 });   // 金曜1回
    KemuriData.daily.importRows(rows);

    const d = KemuriData.daily.dow();
    const mon = d.rows[1], fri = d.rows[5];
    assert.equal(mon.days, 5);
    assert.equal(mon.thin, false);
    assert.ok(mon.index != null, '月曜の指数が出ていない');
    assert.equal(fri.days, 1);
    assert.equal(fri.thin, true, '1日ぶんの曜日が「当てにならない」になっていない');
    assert.equal(fri.index, null, '当てにならない曜日の指数を出している');
  });
});

describe('明日の仕込み予測', () => {
  test('データが無いときは「まだ出せない」理由を返す', () => {
    const { KemuriData } = loadFull();
    const f = KemuriData.forecast('2026-11-11');
    assert.equal(f.mode, '', '予測が出ている');
    assert.equal(f.why, 'nodata', '理由が nodata でない');
    assert.equal(f.stockItems, 0);
  });

  test('在庫はあるが売上が無いときも nodata', () => {
    const { KemuriData } = loadFull({
      initial: {
        kemuri_reitou_v1: JSON.stringify({ v: 1, items: [{ id: 1, name: 'ポテトフライ', stock: 10, min: 5, per: 1 }], map: {} }),
      },
    });
    const f = KemuriData.forecast('2026-11-11');
    assert.equal(f.hasStock, true);
    assert.equal(f.stockItems, 1);
    assert.equal(f.why, 'nodata');
  });

  test('backtest は試せる日が無ければ tested:0', () => {
    const { KemuriData } = loadFull();
    const b = KemuriData.backtest({ days: 40 });
    assert.equal(b.tested, 0);
    assert.deepEqual(plain(b.rows), []);
  });
});

describe('POS CSV の読み取り（pos-source.js）', () => {
  test('見出しありのCSVから列を当てる', () => {
    const { KemuriPos } = loadFull();
    const csv = [
      'ソート:,金額順.',
      '商品名,出数,売上金額',
      'ポテトフライ,36,18000',
      '茶豆,22,8800',
      '合計,58,26800',
    ].join('\n');
    const parsed = KemuriPos.CsvManualSource.fromText(csv, 'test.csv');
    assert.equal(parsed.headIdx, 1, '見出し行を取り違えている（1行目の「金額順.」を掴んでいないか）');
    assert.equal(parsed.cols.name, 0);
    assert.equal(parsed.cols.qty, 1);

    const sales = plain(KemuriPos.CsvManualSource.toSales(parsed, { from: '2026-11-01', to: '2026-11-01' }));
    assert.equal(sales.length, 2, '合計行が売上として読まれている');
    assert.equal(sales[0].posName, 'ポテトフライ');
    assert.equal(sales[0].qty, 36);
    assert.equal(sales[0].day, '2026-11-01', '日付列が無いとき期間の開始日が使われていない');
  });

  test('見出し無しの貼り付け（商品名⇥出数）も読める', () => {
    const { KemuriPos } = loadFull();
    const parsed = KemuriPos.CsvManualSource.fromText('ポテトフライ\t36\n茶豆\t22', '貼り付け');
    assert.equal(parsed.headIdx, -1, '見出し無しと判定されていない');
    const sales = plain(KemuriPos.CsvManualSource.toSales(parsed, { from: '2026-11-01' }));
    assert.equal(sales.length, 2);
    assert.equal(sales[0].qty, 36);
  });

  test('「538円」「7.8%」を出数と間違えない', () => {
    const { KemuriPos } = loadFull();
    const parsed = KemuriPos.CsvManualSource.fromText('ポテトフライ\t538円\t7.8%\t36', '貼り付け');
    const sales = plain(KemuriPos.CsvManualSource.toSales(parsed, { from: '2026-11-01' }));
    assert.equal(sales[0].qty, 36, '円や%を出数として読んでいる');
  });

  test('抽出期間をCSVから読み取る', () => {
    const { KemuriPos } = loadFull();
    const rows = [['抽出期間:', '2026-09-01～2026-09-15'], ['商品名', '出数'], ['ポテトフライ', '36']];
    const p = plain(KemuriPos.CsvManualSource.periodFromRows(rows, 1));
    assert.equal(p.from, '2026-09-01');
    assert.equal(p.to, '2026-09-15');
    assert.equal(p.auto, true);
  });

  test('自動取得・API連携は「準備中」のまま（勝手に有効化されていない）', () => {
    const { KemuriPos } = loadFull();
    assert.equal(KemuriPos.CsvAutoSource.ready, false, 'CSV自動取得が有効化されている');
    assert.equal(KemuriPos.ApiPosSource.ready, false, 'E-POS API連携が有効化されている');
    assert.equal(plain(KemuriPos.available()).length, 1, '準備中の取得元が選べるようになっている');
    assert.equal(KemuriPos.current().id, 'csv');
  });
});
