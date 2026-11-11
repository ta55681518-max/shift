/* 売上履歴（kemuri-core.js）の振るまいを固定する。
   ここが崩れると「売上が水増しされる」「在庫が二重に減る」が起きる。
   本番データには触らない（Map の上だけで動く）。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, plain } from './helpers/env.mjs';

const SALES_KEY = 'kemuri_sales_v1';

function sale(o) {
  return {
    key: o.key, at: o.at ?? '', day: o.day, ticket: o.ticket ?? '',
    posName: o.posName, qty: o.qty, amount: o.amount ?? 0,
  };
}

describe('norm()（POS対応表のキー生成）— 絶対に変えてはいけない', () => {
  const { KemuriCore } = loadApp();

  test('空白を落として小文字化し、全角を半角にする', () => {
    assert.equal(KemuriCore.norm('ポテト フライ'), 'ポテトフライ');
    assert.equal(KemuriCore.norm('ポテト　フライ'), 'ポテトフライ');
    assert.equal(KemuriCore.norm('ABC'), 'abc');
    assert.equal(KemuriCore.norm('ＡＢＣ'), 'abc');
    assert.equal(KemuriCore.norm('ｶﾞｰﾘｯｸ'), 'ガーリック');
    assert.equal(KemuriCore.norm(null), '');
    assert.equal(KemuriCore.norm(undefined), '');
  });

  test('num() は数字以外を落とす', () => {
    assert.equal(KemuriCore.num('1,250円'), 1250);
    assert.equal(KemuriCore.num('-3.5'), -3.5);
    assert.equal(KemuriCore.num(''), 0);
    assert.equal(KemuriCore.num('あ'), 0);
  });
});

describe('日付の小道具', () => {
  const { KemuriCore } = loadApp();
  test('dayOf / addDays / dowOf', () => {
    assert.equal(KemuriCore.dayOf('2026/09/14 18:20'), '2026-09-14');
    assert.equal(KemuriCore.dayOf('2026-9-4'), '2026-09-04');
    assert.equal(KemuriCore.addDays('2026-11-30', 1), '2026-12-01');
    assert.equal(KemuriCore.prevDay('2026-01-01'), '2025-12-31');
    assert.equal(KemuriCore.dowOf('2026-11-10'), 2);  // 火曜
  });
});

describe('明細形式（伝票番号あり）の取込', () => {
  test('1回目は記録され、同じキーの2回目は足されない', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    const rows = [sale({ key: 'TA1ぽてと3#1', at: '2026-11-01 18:00', day: '2026-11-01', ticket: 'A1', posName: 'ポテトフライ', qty: 3, amount: 1500 })];

    const r1 = S.record(rows, 'imp1');
    assert.equal(r1.saved, true);
    assert.equal(r1.qty, 3);

    const r2 = S.record(rows, 'imp2');
    assert.equal(r2.qty, 0, '同じ伝票行が二重に足された');

    const day = S.byDay('2026-11-01');
    assert.equal(day.length, 1);
    assert.equal(day[0].qty, 3, '出数が水増しされている');
    assert.equal(day[0].amount, 1500);
  });

  test('取消で足したぶんがきれいに戻る', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    S.record([sale({ key: 'TA1x2#1', at: '2026-11-01 18:00', day: '2026-11-01', ticket: 'A1', posName: 'もも串', qty: 2, amount: 400 })], 'impX');
    assert.equal(S.byDay('2026-11-01')[0].qty, 2);

    assert.equal(S.undo('impX'), true);
    assert.deepEqual(plain(S.byDay('2026-11-01')), [], '取消しても残っている');
    assert.equal(S.hasLog('impX'), false, '取消用の記録が残っている');
  });
});

describe('集計形式（伝票番号なし）の取込', () => {
  test('同じ日を入れ直すと「増えたぶんだけ」足される', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;

    S.record([sale({ key: 'Dぽ10#1', day: '2026-11-02', posName: 'ポテトフライ', qty: 10, amount: 5000 })], 'a');
    assert.equal(S.byDay('2026-11-02')[0].qty, 10);

    /* POSから出し直して 10 → 14 に増えた */
    const r = S.record([sale({ key: 'Dぽ14#1', day: '2026-11-02', posName: 'ポテトフライ', qty: 14, amount: 7000 })], 'b');
    assert.equal(r.qty, 4, '差分ではなく全量が足されている');
    assert.equal(S.byDay('2026-11-02')[0].qty, 14);
    assert.equal(S.byDay('2026-11-02')[0].amount, 7000);
  });

  test('減っている（＝もう入っている）ときは何も足さない', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    S.record([sale({ key: 'Dx10#1', day: '2026-11-02', posName: 'もも串', qty: 10 })], 'a');
    const r = S.record([sale({ key: 'Dx8#1', day: '2026-11-02', posName: 'もも串', qty: 8 })], 'b');
    assert.equal(r.qty, 0);
    assert.equal(S.byDay('2026-11-02')[0].qty, 10);
  });

  test('期間まとめの取込には印（span）が付く', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    S.record(
      [sale({ key: 'Dx300#1', day: '2026-09-01', posName: 'ポテトフライ', qty: 300 })],
      'lump',
      { from: '2026-09-01', to: '2026-09-30' },
    );
    const span = S.spanOf('2026-09-01');
    assert.ok(span, '期間まとめの印が付いていない（9/1に300個売れたと誤読される）');
    assert.equal(span.from, '2026-09-01');
    assert.equal(span.to, '2026-09-30');

    const st = S.stats();
    assert.equal(st.lumpedDays, 1);
    assert.equal(st.dailyDays, 0, 'まとめ取込が「日別」に数えられている');
    assert.equal(st.to, '2026-09-30', '本当の期間の終わりが stats に反映されていない');
  });
});

describe('保存の失敗を «成功» と言わない（E2）', () => {
  test('容量オーバー時は saved:false を返し、端末の中身を書き換えない', () => {
    const { KemuriCore, __storage } = loadApp({ mode: 'quota' });
    const S = KemuriCore.sales;
    const r = S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'もも串', qty: 5 })], 'imp');
    assert.equal(r.saved, false, '保存できていないのに saved:true を返した');
    assert.equal(__storage._raw(SALES_KEY), null, '失敗したのに端末に書かれている');
  });

  test('書けたふりをされた場合も saved:false（読み戻し検証が効いている）', () => {
    const { KemuriCore } = loadApp({ mode: 'silentFail' });
    const S = KemuriCore.sales;
    const r = S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'もも串', qty: 5 })], 'imp');
    assert.equal(r.saved, false, '読み戻し検証が効いていない');
  });

  test('保存に失敗したあと load() は端末の実データを返す（壊れた手元が残らない）', () => {
    const base = { v: 1, days: { '2026-10-01': { 'もも串': { name: 'もも串', qty: 7, amount: 1400 } } }, spans: {}, seen: {}, closed: {}, totals: {}, logs: {}, order: [], updatedAt: '' };
    const { KemuriCore } = loadApp({ initial: { [SALES_KEY]: JSON.stringify(base) }, mode: 'quota' });
    const S = KemuriCore.sales;
    S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'ポテトフライ', qty: 5 })], 'imp');
    /* 失敗後に読み直したら、元の7本だけが見えるべき */
    const day = S.byDay('2026-10-01');
    assert.equal(day[0].qty, 7);
    assert.deepEqual(plain(S.byDay('2026-11-01')), [], '失敗したぶんが手元に残っている');
  });
});

describe('別タブとの競合を検出する（E1）', () => {
  test('読んだあとに別タブが書いていたら、書かずに conflict を立てる', () => {
    const { KemuriCore, __storage } = loadApp();
    const S = KemuriCore.sales;
    S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'もも串', qty: 1 })], 'imp');

    S.load();                                   // この画面が読む
    const before = __storage._raw(SALES_KEY);
    __storage._set(SALES_KEY, JSON.stringify({ v: 1, days: {}, spans: {}, seen: {}, closed: {}, totals: {}, logs: {}, order: [], updatedAt: 'other-tab' }));

    const ok = S.save();
    assert.equal(ok, false, '別タブの変更を上書きしてしまった');
    assert.equal(S.conflict, true, 'conflict が立っていない');
    assert.notEqual(__storage._raw(SALES_KEY), before);
    assert.match(__storage._raw(SALES_KEY), /other-tab/, '別タブの内容が消された');
  });
});

describe('壊れた保存データを «空» で上書きしない（E3）', () => {
  test('読めないJSONのときは broken を立てて、保存を一切しない', () => {
    const { KemuriCore, __storage } = loadApp({ initial: { [SALES_KEY]: '{壊れている' } });
    const S = KemuriCore.sales;
    S.load();
    assert.ok(S.broken, 'broken が立っていない');
    assert.equal(S.save(), false, '壊れたデータを上書きしようとした');
    assert.equal(__storage._raw(SALES_KEY), '{壊れている', '元データが書き換えられた');

    const r = S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'もも串', qty: 1 })], 'imp');
    assert.equal(r.saved, false);
    assert.equal(__storage._raw(SALES_KEY), '{壊れている', '元データが書き換えられた');
  });
});

describe('保存期間の整理', () => {
  /* 保存期間は «暦の日数» ではなく «新しいほうから keepDays 件の日付» で決まる。
     日付がいくら古くても、入っている日数が keepDays に収まっていれば記録される。 */
  test('日数が上限内なら、何年前の日でも記録される', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    assert.equal(S.keepDays, 500, '保存する日数の上限が変わっている（保存形式の変更）');

    const r = S.record([
      sale({ key: 'new', day: '2026-11-01', posName: 'もも串', qty: 1 }),
      sale({ key: 'old', day: '2024-01-01', posName: 'ポテトフライ', qty: 99 }),
    ], 'imp');

    assert.deepEqual(plain(r.outOfRange), [], '上限内なのに期間外とされた');
    assert.equal(S.byDay('2024-01-01')[0].qty, 99, '古い日が記録されていない');
    assert.equal(S.byDay('2026-11-01')[0].qty, 1);
  });

  test('上限を超える日数を入れると、古い日は「最初から記録しない」', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    const keep = S.keepDays;

    /* まず上限ぴったりまで埋める（2026-01-01 から連続 keep 日） */
    const base = [];
    let d = '2026-01-01';
    for (let i = 0; i < keep; i++) {
      base.push(sale({ key: 'f' + i, day: d, posName: 'もも串', qty: 1 }));
      d = KemuriCore.addDays(d, 1);
    }
    const r0 = S.record(base, 'fill');
    assert.equal(r0.saved, true);
    assert.equal(S.days().length, keep, `${keep}日ぶん入っていない`);

    /* ここに «いちばん古い日より前» を1日足すと、それは記録されない */
    const r1 = S.record([sale({ key: 'ancient', day: '2020-01-01', posName: 'ポテトフライ', qty: 99 })], 'old');
    assert.deepEqual(plain(r1.outOfRange), ['2020-01-01'], 'outOfRange が返っていない');
    assert.deepEqual(plain(S.byDay('2020-01-01')), [], '保存期間外の日が記録されてしまった');
    assert.equal(S.days().length, keep, '上限を超えて日数が増えている');
  });

  test('clear() で全部消える', () => {
    const { KemuriCore, __storage } = loadApp();
    const S = KemuriCore.sales;
    S.record([sale({ key: 'k1', day: '2026-11-01', posName: 'もも串', qty: 1 })], 'imp');
    S.clear();
    assert.equal(__storage._raw(SALES_KEY), null);
    assert.deepEqual(plain(S.days()), []);
  });
});

describe('読み取りAPI', () => {
  test('range / days / stats / usage', () => {
    const { KemuriCore } = loadApp();
    const S = KemuriCore.sales;
    S.record([
      sale({ key: 'a', day: '2026-11-01', posName: 'もも串', qty: 5, amount: 1000 }),
      sale({ key: 'b', day: '2026-11-02', posName: 'もも串', qty: 3, amount: 600 }),
      sale({ key: 'c', day: '2026-11-02', posName: 'ポテトフライ', qty: 9, amount: 4500 }),
    ], 'imp');

    assert.deepEqual(plain(S.days()), ['2026-11-01', '2026-11-02']);

    const all = S.range();
    const momo = all.find(x => x.name === 'もも串');
    assert.equal(momo.qty, 8, '期間合計が合わない');
    assert.equal(momo.days, 2);
    assert.equal(all[0].name, 'ポテトフライ', '多い順に並んでいない');

    const only1 = S.range('2026-11-01', '2026-11-01');
    assert.equal(only1.length, 1);

    const st = S.stats();
    assert.equal(st.days, 2);
    assert.equal(st.items, 2);
    assert.equal(st.qty, 17);

    const ug = S.usage();
    assert.ok(ug.bytes > 0);
    assert.equal(ug.keepDays, S.keepDays);
  });
});
