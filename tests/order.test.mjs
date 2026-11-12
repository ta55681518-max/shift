/* ============================================================
   オードブル予約（order.html）の受付ルールを固定する。
   ------------------------------------------------------------
   backlog A-2。order.html 本体には触らない。

   ここが守るもの
     ・受付の開け閉め（しめきり・上限・手動停止）
     ・1回の予約は20個まで／残り個数を超えさせない
     ・入力チェック（名前・電話10〜11桁・数量）
     ・合計金額の計算
     ・予約番号をページ側で必ず出すこと
     ・送信が失敗したときボタンが元に戻ること

   お客さまが使う画面なので、«受付を止めるべきときに止まる» ことと
   «予約番号が必ず出る» ことを特に見ている。
   ============================================================ */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/env.mjs';
import { loadHtmlApp, stubCalls } from './helpers/html-app.mjs';

const EXPOSE = [
  'INFO', 'QTY', 'PENDING', 'LAST_REMAIN', 'DEFAULT_INFO', 'GAS_URL',
  'buildUI', 'showClosed', 'maxQty', 'chgQty', 'pickedItems', 'updateTotal',
  'validate', 'makeOrderId', 'submitOrder', 'closeConfirm',
  'yen', 'fmtT', 'fmtDateJa', 'todayYmd',
];

/** 予約画面を «画面なし» で起こす。info を渡すと設定を差し替えられる */
function load({ info = {}, buildUI = true } = {}) {
  const h = loadHtmlApp({ file: 'order.html', bootstrap: 'init', expose: EXPOSE });
  h.toasts = stubCalls(h.sandbox, ['toast']);
  h.app.INFO = Object.assign({}, plain(h.app.DEFAULT_INFO), {
    /* しめきりを未来に固定する（実時間で結果が変わらないように） */
    fixedDate: '2099-12-31',
    deadline: '2099-12-30',
  }, info);
  if (buildUI) h.app.buildUI();
  /** 入力欄に値を入れる */
  h.fill = (vals) => {
    for (const [id, v] of Object.entries(vals)) h.document.getElementById(id).value = v;
  };
  /** 「受付終了」画面が出たか */
  h.isClosed = () => h.document.getElementById('closed').style.display === 'block';
  h.closedMsg = () => h.document.getElementById('closedMsg').textContent;
  return h;
}

/** 名前・電話・時間をひととおり埋める */
function fillValid(h, extra = {}) {
  h.fill(Object.assign({ cName: '山田太郎', cTel: '090-1234-5678', pTime: '12:30', note: '' }, extra));
}

describe('予約：初期設定', () => {
  test('商品・お渡し日・受け取り時間が入っている', () => {
    const { app } = load({ buildUI: false });
    const d = plain(app.DEFAULT_INFO);
    assert.ok(d.items.length >= 1, '商品が無い');
    assert.ok(d.items[0].price > 0, '値段が入っていない');
    assert.match(d.fixedDate, /^\d{4}-\d{2}-\d{2}$/, 'お渡し日の形が違う');
    assert.match(d.deadline, /^\d{4}-\d{2}-\d{2}$/, 'しめきりの形が違う');
    assert.ok(d.timeFrom < d.timeTo, '受け取り時間の範囲が逆');
    assert.equal(d.closed, false);
  });

  test('送信先はGASのURLで、httpsである', () => {
    const { app } = load({ buildUI: false });
    assert.match(app.GAS_URL, /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/,
      '送信先が GAS のウェブアプリURLの形になっていない');
  });

  test('時刻と金額の表示', () => {
    const { app } = load({ buildUI: false });
    assert.equal(app.fmtT(12), '12:00');
    assert.equal(app.fmtT(12.5), '12:30');
    assert.equal(app.yen(8000), '8,000');
    assert.equal(app.fmtDateJa('2026-08-27'), '8月27日（木）');
  });
});

describe('予約：受付の開け閉め', () => {
  test('ふつうは受付が開いている', () => {
    const h = load();
    assert.equal(h.isClosed(), false, '受付が閉じてしまった');
    assert.equal(h.document.getElementById('app').style.display, 'block');
  });

  test('手動で停止していれば閉じる', () => {
    const h = load({ info: { closed: true } });
    assert.equal(h.isClosed(), true, '停止中なのに受付が開いている');
    assert.equal(h.closedMsg(), 'ご予約の受付は終了しました');
  });

  test('しめきりを過ぎていれば閉じる', () => {
    const h = load({ info: { deadline: '2000-01-01' } });
    assert.equal(h.isClosed(), true, 'しめきり後なのに受付が開いている');
  });

  test('しめきり当日はまだ受け付ける（«当日まで» の境目）', () => {
    const h = load({ info: { deadline: null } });
    h.app.INFO.deadline = h.app.todayYmd();
    h.app.buildUI();
    assert.equal(h.isClosed(), false, 'しめきり当日に閉じてしまった');
  });

  test('残り個数が0なら閉じる', () => {
    const h = load({ info: { remain: 0 } });
    assert.equal(h.isClosed(), true, '上限に達したのに受付が開いている');
    assert.match(h.closedMsg(), /上限/);
  });

  test('残り1個なら開いている', () => {
    const h = load({ info: { remain: 1 } });
    assert.equal(h.isClosed(), false);
  });
});

describe('予約：数量の上限', () => {
  test('GASにつながらないときは1回20個まで', () => {
    const { app } = load({ info: { remain: null } });
    assert.equal(app.maxQty(), 20);
  });

  test('残り個数が20未満ならそちらが上限', () => {
    const { app } = load({ info: { remain: 3 } });
    assert.equal(app.maxQty(), 3);
  });

  test('残り個数が20を超えても20が上限', () => {
    const { app } = load({ info: { remain: 100 } });
    assert.equal(app.maxQty(), 20);
  });

  test('残り個数がマイナスでも0未満にはしない', () => {
    const { app } = load({ info: { remain: -5 } });
    assert.equal(app.maxQty(), 0);
  });

  test('「＋」で20個を超えられない', () => {
    const h = load();
    for (let i = 0; i < 25; i++) h.app.chgQty(0, 1);
    assert.equal(h.app.QTY[0], 20, '20個を超えて入れられた');
    assert.ok(h.toasts.some(m => m.includes('20個まで')), '上限の知らせが出ていない');
  });

  test('残り個数が少ないときは残り個数で止まり、そう伝える', () => {
    const h = load({ info: { remain: 3 } });
    for (let i = 0; i < 5; i++) h.app.chgQty(0, 1);
    assert.equal(h.app.QTY[0], 3, '残り個数を超えて入れられた');
    assert.ok(h.toasts.some(m => m.includes('残り3個')), '残り個数が伝わっていない');
  });

  test('「−」で0より下にはならない', () => {
    const h = load();
    h.app.chgQty(0, 1);
    h.app.chgQty(0, -1);
    h.app.chgQty(0, -1);
    assert.equal(h.app.QTY[0], 0, 'マイナスの数量ができた');
  });
});

describe('予約：合計金額', () => {
  test('数量×単価を足す', () => {
    const h = load({ info: { items: [{ name: 'A', price: 8000 }, { name: 'B', price: 1500 }] } });
    h.app.chgQty(0, 1);
    h.app.chgQty(0, 1);
    h.app.chgQty(1, 1);
    const picked = plain(h.app.pickedItems());
    assert.deepEqual(picked, [
      { name: 'A', price: 8000, qty: 2 },
      { name: 'B', price: 1500, qty: 1 },
    ]);
    h.app.updateTotal();
    assert.equal(h.document.getElementById('totalAmt').textContent, '17,500',
      '合計金額が合っていない');
  });

  test('0個の品は数えない', () => {
    const h = load({ info: { items: [{ name: 'A', price: 8000 }, { name: 'B', price: 1500 }] } });
    h.app.chgQty(1, 1);
    assert.deepEqual(plain(h.app.pickedItems()), [{ name: 'B', price: 1500, qty: 1 }]);
  });
});

describe('予約：入力チェック', () => {
  test('ぜんぶ正しければ予約の中身を返す', () => {
    const h = load();
    h.app.chgQty(0, 1);
    h.app.chgQty(0, 1);
    fillValid(h, { note: 'よろしく' });

    const p = plain(h.app.validate());
    assert.ok(p, '正しい入力なのに通らなかった');
    assert.equal(p.name, '山田太郎');
    assert.equal(p.tel, '09012345678', '電話番号からハイフンが取れていない');
    assert.equal(p.date, '2099-12-31');
    assert.equal(p.time, '12:30');
    assert.equal(p.total, 16000, '合計金額が違う');
    assert.equal(p.note, 'よろしく');
    assert.deepEqual(p.items, [{ name: 'オードブル', price: 8000, qty: 2 }]);
    assert.match(p.orderId, /^K\d{4}-\d{4}[A-Z]$/, '予約番号の形が違う');
  });

  test('数量0では通らない', () => {
    const h = load();
    fillValid(h);
    assert.equal(h.app.validate(), null, '数量0で予約が通った');
    assert.ok(h.toasts.some(m => m.includes('数量')), '数量の知らせが出ていない');
  });

  test('名前が空では通らない', () => {
    const h = load();
    h.app.chgQty(0, 1);
    fillValid(h, { cName: '   ' });
    assert.equal(h.app.validate(), null, '名前が空で予約が通った');
    assert.ok(h.toasts.some(m => m.includes('お名前')));
  });

  test('電話番号が9桁では通らない', () => {
    const h = load();
    h.app.chgQty(0, 1);
    fillValid(h, { cTel: '090-123-456' });
    assert.equal(h.app.validate(), null, '9桁の電話番号で通った');
    assert.ok(h.toasts.some(m => m.includes('10〜11桁')));
  });

  test('電話番号が12桁では通らない', () => {
    const h = load();
    h.app.chgQty(0, 1);
    fillValid(h, { cTel: '090123456789' });
    assert.equal(h.app.validate(), null, '12桁の電話番号で通った');
  });

  test('固定電話の10桁は通る', () => {
    const h = load();
    h.app.chgQty(0, 1);
    fillValid(h, { cTel: '098(123)4567' });
    const p = plain(h.app.validate());
    assert.ok(p, '10桁の固定電話が弾かれた');
    assert.equal(p.tel, '0981234567');
  });

  test('残り個数より多い数量は通らない（画面の表示が古かった場合の最後の砦）', () => {
    const h = load();
    h.app.chgQty(0, 1);
    h.app.chgQty(0, 1);
    h.app.chgQty(0, 1);     // 3個いれる
    h.app.INFO.remain = 2;  // あとから残りが2に減った
    fillValid(h);
    assert.equal(h.app.validate(), null, '残り個数を超えた予約が通った');
    assert.ok(h.toasts.some(m => m.includes('残り2個')));
  });

  test('予約番号は紛らわしい文字（I・L・O）を使わない', () => {
    const { app } = load();
    for (let i = 0; i < 200; i++) {
      const id = app.makeOrderId();
      assert.match(id, /^K\d{4}-\d{4}[A-HJ-KM-NP-Z]$/, `読み間違えやすい文字が入った: ${id}`);
    }
  });
});

describe('予約：送信', () => {
  /** 送信できる状態まで進める */
  function ready(h) {
    h.app.chgQty(0, 1);
    fillValid(h);
    h.app.PENDING = h.app.validate();
    h.document.getElementById('okBtn').disabled = false;
    return h;
  }

  test('成功すると「ありがとう」画面に切り替わり、予約番号が出る', async () => {
    const h = ready(load());
    h.sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, orderId: 'K1231-1200A' }) });
    await h.app.submitOrder();

    assert.equal(h.document.getElementById('thanks').style.display, 'block', 'お礼画面が出ていない');
    assert.equal(h.document.getElementById('app').style.display, 'none');
    assert.equal(h.document.getElementById('orderIdLabel').textContent, 'K1231-1200A');
  });

  test('サーバーが番号を返さなくても、ページ側の番号を出す', async () => {
    const h = ready(load());
    const mine = h.app.PENDING.orderId;
    h.sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
    await h.app.submitOrder();
    assert.equal(h.document.getElementById('orderIdLabel').textContent, mine,
      '番号が空のままになった（お客さまに控えを渡せない）');
  });

  test('通信が失敗したらボタンが元に戻る（もう一度押せる）', async () => {
    const h = ready(load());
    h.sandbox.fetch = () => Promise.reject(new Error('offline'));
    await h.app.submitOrder();

    const btn = h.document.getElementById('okBtn');
    assert.equal(btn.disabled, false, 'ボタンが押せないままになった');
    assert.equal(btn.textContent, '予約を確定する');
    assert.ok(h.toasts.some(m => m.includes('失敗')), '失敗が伝わっていない');
    assert.notEqual(h.document.getElementById('thanks').style.display, 'block', '失敗したのにお礼画面が出た');
  });

  test('上限に達していたと返ってきたら、残り個数を受け取り直す', async () => {
    const h = ready(load());
    h.sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'limit', remain: 3 }) });
    await h.app.submitOrder();

    assert.equal(h.app.INFO.remain, 3, '残り個数が更新されていない');
    assert.equal(h.isClosed(), false, 'まだ3個あるのに受付を閉じた');
    assert.ok(h.toasts.some(m => m.includes('残り3個')));
  });

  test('残りが0で上限なら受付を閉じる', async () => {
    const h = ready(load());
    h.sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'limit', remain: 0 }) });
    await h.app.submitOrder();

    assert.equal(h.isClosed(), true, '上限なのに受付が開いている');
    assert.match(h.closedMsg(), /上限/);
  });

  test('受付終了と返ってきたら受付を閉じる', async () => {
    const h = ready(load());
    h.sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'closed' }) });
    await h.app.submitOrder();

    assert.equal(h.isClosed(), true);
    assert.equal(h.closedMsg(), 'ご予約の受付は終了しました');
  });

  test('確定前（PENDING なし）に押しても何も起きない', async () => {
    const h = load();
    let called = false;
    h.sandbox.fetch = () => { called = true; return Promise.reject(new Error('x')); };
    await h.app.submitOrder();
    assert.equal(called, false, '中身が無いのに送信した');
  });
});
