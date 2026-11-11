/* ★ Gate 0：バックアップの往復テスト
   ------------------------------------------------------------
   オーナーのデータは端末の localStorage の中にしか無い。
   「書き出して、読み込んだら、元と同じ」が成り立たないなら、
   自動開発で壊したときに戻す手段が無いことになる。

   このファイルが緑でない限り、自動マージは解禁しない。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, plain, APP_KEYS } from './helpers/env.mjs';

/* 本番と同じ «形» の、中身は架空のデータ */
function fixture() {
  return {
    kemuri_reitou_v1: JSON.stringify({
      v: 1, seq: 5,
      items: [
        { id: 1, name: 'ポテトフライ', stock: 4.5, min: 5, per: 1, cost: 0, cat: 'frozen', sup: '丸大', unit: '袋' },
        { id: 2, name: '串カツ', stock: 12, min: 10, per: 1, cost: 0, cat: 'frozen', sup: '', unit: '個' },
      ],
      /* キーは norm(POS商品名)。norm はカタカナをひらがなに変換しないのでそのまま */
      map: { 'ポテトフライ': { item: 1, label: 'ポテトフライ' }, '鶏みそ串カツ': { item: 2, label: '鶏みそ串カツ' } },
      seen: { 'TA1ポテトフライ3#1': '2026-11-01' },
      applied: { 'S2026-11-01ポテトフライ': 3 },
      history: [{ at: '2026-11-01T10:00:00.000Z', name: 'ポテトフライ', before: 5, after: 4.5, reason: '棚卸（数え直し）' }],
      imports: [{ id: 3, at: '2026-11-01T10:00:00.000Z', file: 'POSから直接', rows: 1, lines: [], keys: [], applied: [], undone: false }],
      csvMap: null, ordered: {}, sups: ['丸大'], supCfg: {}, orders: [],
      last: { cat: 'frozen', sup: '丸大', unit: '袋' },
    }),
    kemuri_sales_v1: JSON.stringify({
      v: 1,
      days: { '2026-11-01': { 'ぽてとふらい': { name: 'ポテトフライ', qty: 3, amount: 1500 } } },
      spans: {}, seen: {}, closed: {}, totals: {}, logs: {}, order: [], updatedAt: '2026-11-01T10:00:00.000Z',
    }),
    kemuri_daily_v1: JSON.stringify({
      v: 1,
      days: { '2026-11-01': { weather: '晴', gross: 103220, net: 93897, guests: 13, groups: 12 } },
      updatedAt: '2026-11-01T10:00:00.000Z',
    }),
    kemuri_costs_v1: JSON.stringify({
      v: 1,
      items: { 'もも': { name: 'もも', unit: '1本', price: 84.38, sale: 220, tax: '未統一', status: '計算済', category: '串焼き', note: '', updatedAt: '' } },
      updatedAt: '',
    }),
    kemuri_recipes_v1: JSON.stringify({
      v: 1,
      /* キーは norm(メニュー名)。norm は NFKC＋空白除去＋小文字化なので、カタカナはそのまま */
      items: { 'シーザーサラダ': { name: 'シーザーサラダ', parts: [{ name: '燻製ベーコン', qty: 1, unit: '枚' }] } },
      seeded: 1, updatedAt: '',
    }),
    kemuri_zaiko_v1: JSON.stringify({ ingredients: [{ name: '豚バラ串', unit: '本', qty: 20, min: 5 }], recipes: {}, menus: [], days: {}, log: [] }),
    kemuri_kushiyaki_v1: JSON.stringify({
      items: { 'もも': { min: 10, par: 40, per: 1, cost: 84, costMode: 'piece', gPer: 0, gPrice: 0, keep: '3', lots: [{ id: 1, made: '2026-11-01', exp: '2026-11-04', qty: 25 }] } },
      applied: {}, log: [], losses: [], seq: 2, syncZaiko: false, reflectBy: 'material',
      posFrom: '2026-11-01', posAuto: true, posMap: {}, posMarks: {}, posLog: [],
    }),
    kemuri_hacchu_v1: JSON.stringify({
      suppliers: [{ id: 's1', name: '丸大', emoji: '🥩' }],
      products: [{ id: 'p1', sid: 's1', name: '鶏もも肉', unit: 'kg', cat: 'お肉', pin: false, freq: 3, last: null }],
      order: {}, done: {}, sentToday: {}, history: [], supDates: {},
    }),
  };
}

describe('★ Gate 0：バックアップの往復', () => {
  test('書き出して読み込むと、8キーすべてが1バイトも変わらない', () => {
    const data = fixture();
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: data });

    const text = a.KemuriBackup.text();
    assert.ok(text.length > 100, '書き出しが空');

    /* まっさらな別端末に読み込む */
    const b = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {} });
    const box = b.KemuriBackup.parse(text);
    assert.ok(box, 'バックアップとして読めなかった');

    const res = b.KemuriBackup.apply(box);
    assert.deepEqual(plain(res.ng), [], `入らなかったキーがある: ${plain(res.ng)}`);
    assert.equal(plain(res.ok).length, APP_KEYS.length, '入ったキーの数が合わない');

    for (const k of APP_KEYS) {
      assert.equal(b.__storage._raw(k), data[k], `${k} の中身が往復で変わった`);
    }
  });

  test('書き出しに8キーすべてが含まれている（持ち出し漏れが無い）', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: fixture() });
    const list = plain(a.KemuriBackup.summary(a.KemuriBackup.collect()));
    const keys = list.map(x => x.key).sort();
    assert.deepEqual(keys, [...APP_KEYS].sort(),
      '書き出しに含まれないキーがある（＝消えたら戻せないデータがある）');
  });

  test('KEYS の凍結：持ち出す対象が減っていない', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {} });
    const keys = plain(a.KemuriBackup.KEYS);
    for (const k of APP_KEYS) {
      assert.ok(keys.includes(k), `${k} がバックアップ対象から外された`);
    }
  });

  test('選んだキーだけを戻せる（棚卸したばかりの在庫を壊さない）', () => {
    const data = fixture();
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: data });
    const text = a.KemuriBackup.text();

    /* こちらの端末では在庫を数え直したばかり。売上だけもらいたい */
    const mineReitou = JSON.stringify({ v: 1, seq: 1, items: [{ id: 9, name: '棚卸済み', stock: 99, min: 1, per: 1, cost: 0 }], map: {}, seen: {}, applied: {}, history: [], imports: [] });
    const b = loadApp({
      files: ['kemuri-core.js', 'kemuri-backup.js'],
      initial: { kemuri_reitou_v1: mineReitou },
    });
    const box = b.KemuriBackup.parse(text);
    const res = b.KemuriBackup.apply(box, ['kemuri_sales_v1']);

    assert.deepEqual(plain(res.ok), ['kemuri_sales_v1']);
    assert.equal(b.__storage._raw('kemuri_sales_v1'), data.kemuri_sales_v1, '売上が入っていない');
    assert.equal(b.__storage._raw('kemuri_reitou_v1'), mineReitou, '選んでいない在庫が上書きされた');
    assert.equal(b.__storage._raw('kemuri_costs_v1'), null, '選んでいないキーが書かれた');
  });

  test('読み込む前に「何が何に置きかわるか」が出せる', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: fixture() });
    const now = plain(a.KemuriBackup.current());
    assert.match(now.kemuri_reitou_v1, /2品目/, '在庫の件数が出ていない');
    assert.match(now.kemuri_sales_v1, /1日ぶん/, '売上の日数が出ていない');
    assert.match(now.kemuri_daily_v1, /1日ぶん/, '日別売上の日数が出ていない');
    assert.match(now.kemuri_costs_v1, /1件/, '原価の件数が出ていない');
    assert.match(now.kemuri_recipes_v1, /1件/, 'レシピの件数が出ていない');
  });

  test('壊れた入力は読み込まない（null を返す）', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {} });
    for (const bad of ['', '   ', 'これはJSONではない', '{}', '[]', '{"tag":"other","data":{}}', '{"tag":"kemuri-backup"}', 'null']) {
      assert.equal(a.KemuriBackup.parse(bad), null, `壊れた入力を受け入れた: ${bad.slice(0, 20)}`);
    }
  });

  test('古い形式（在庫アプリだけ）のバックアップも読める', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {} });
    const old = JSON.stringify({ v: 1, items: [{ id: 1, name: 'ポテトフライ', stock: 3, min: 5, per: 1 }], map: {} });
    const box = a.KemuriBackup.parse(old);
    assert.ok(box, '古い形式が読めない');
    assert.equal(box.old, true, '古い形式の印が付いていない');
    const res = a.KemuriBackup.apply(box);
    assert.deepEqual(plain(res.ok), ['kemuri_reitou_v1']);
  });

  test('保存できなかったキーは ng として返る（黙って失敗しない）', () => {
    const data = fixture();
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: data });
    const text = a.KemuriBackup.text();

    const b = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {}, mode: 'quota' });
    const box = b.KemuriBackup.parse(text);
    const res = b.KemuriBackup.apply(box);
    assert.deepEqual(plain(res.ok), [], '書けていないのに ok に入っている');
    assert.equal(plain(res.ng).length, APP_KEYS.length, '失敗が ng に報告されていない');
  });

  test('ファイル名に日時が入る（どのバックアップか見分けられる）', () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: {} });
    assert.match(a.KemuriBackup.filename(), /^kemuri-backup-\d{8}-\d{4}\.json$/);
  });

  test('往復したデータが、アプリから実際に読める（形が生きている）', () => {
    const data = fixture();
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'], initial: data });
    const text = a.KemuriBackup.text();

    const b = loadApp({
      files: ['kemuri-core.js', 'kemuri-backup.js', 'pos-source.js', 'kemuri-data.js'],
      initial: {},
    });
    b.KemuriBackup.apply(b.KemuriBackup.parse(text));
    b.KemuriData.reloadAll();

    /* 売上履歴 */
    assert.equal(b.KemuriCore.sales.byDay('2026-11-01')[0].qty, 3, '復元後に売上が読めない');
    /* 原価 */
    assert.equal(b.KemuriData.costs.priceOf('もも'), 84.38, '復元後に原価が読めない');
    /* レシピ */
    assert.equal(b.KemuriData.recipes.get('シーザーサラダ').parts[0].name, '燻製ベーコン', '復元後にレシピが読めない');
    /* 日別売上 */
    assert.equal(b.KemuriData.daily.get('2026-11-01').gross, 103220, '復元後に日別売上が読めない');
    /* 冷凍在庫 */
    assert.equal(b.KemuriData.stock.items().length, 2, '復元後に在庫品目が読めない');
    assert.equal(b.KemuriData.stock.itemForPos('ポテトフライ').name, 'ポテトフライ', '復元後にPOS対応表が引けない');
  });
});
