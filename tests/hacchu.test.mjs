/* ============================================================
   発注アプリ（hacchu.html）のロジックを固定する。
   ------------------------------------------------------------
   backlog A-1。hacchu.html 本体には触らず、
   いまの振るまいを «仕様» として書き留めるだけ。

   ここが守るもの
     ・発注書に入れた品の増減（changeQty）で数量が壊れない
     ・発注文（buildOrderText）の宛先・書式・業者の切り分け
     ・発注漏れ（missingItems）の拾い方と、送信済みとの連携
     ・送信（markSent）が履歴・頻度・送信済みを同時に動かすこと
   ============================================================ */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/env.mjs';
import { loadHtmlApp, stubCalls } from './helpers/html-app.mjs';

const LS_KEY = 'kemuri_hacchu_v1';

/* 商品IDを固定した土台。seed() は uid() で毎回変わるので使わない。
   supDates は «未来の固定日»。hacchu.html は過去日なら明日に直すので、
   日付を固定するにはこうする必要がある。 */
function fixture() {
  return {
    suppliers: [
      { id: 's1', name: '丸大', emoji: '🥩' },
      { id: 's2', name: '青果', emoji: '🥬' },
    ],
    products: [
      { id: 'p1', sid: 's1', name: '鶏もも肉', unit: 'kg', pin: false, freq: 5, last: null },
      { id: 'p2', sid: 's1', name: '豚バラ', unit: 'kg', pin: true, freq: 0, last: null },
      { id: 'p3', sid: 's1', name: '牛タン', unit: 'kg', pin: false, freq: 1, last: null },
      { id: 'p4', sid: 's2', name: 'キャベツ', unit: '玉', pin: false, freq: 4, last: null },
    ],
    order: {}, done: {}, sentToday: {}, history: [],
    orderDate: '2099-12-31',
    supDates: { s1: '2099-12-31', s2: '2099-12-31' },
  };
}

const EXPOSE = [
  'S', 'LS_KEY',
  'toggleProduct', 'changeQty', 'toggleDone',
  'buildOrderText', 'missingItems', 'markSent', 'copyLastOrder',
  'orderCount', 'orderCountBySup', 'sortedProducts', 'prod', 'supName',
  'dateLabelFor', 'supDate', 'isoDate', 'todayStr', 'save',
];

/** 発注アプリを «画面なし» で起こす */
function load({ state = fixture(), mode = 'ok' } = {}) {
  const h = loadHtmlApp({
    file: 'hacchu.html',
    bootstrap: 'render',
    expose: EXPOSE,
    initial: { [LS_KEY]: JSON.stringify(state) },
    mode,
  });
  /* 画面を作る関数は記録するだけにする（ロジックだけ試す） */
  h.toasts = stubCalls(h.sandbox, ['render', 'toast']);
  return h;
}

describe('発注アプリ：読み込み', () => {
  test('保存済みデータから商品・仕入れ先を復元する', () => {
    const { app } = load();
    assert.equal(plain(app.S.suppliers).length, 2);
    assert.equal(plain(app.S.products).length, 4);
    assert.equal(app.LS_KEY, LS_KEY, '保存キーが変わっている（既存データが読めなくなる）');
  });

  test('保存データが壊れていても初期データで起動する（白画面にしない）', () => {
    const h = loadHtmlApp({
      file: 'hacchu.html',
      bootstrap: 'render',
      expose: EXPOSE,
      initial: { [LS_KEY]: '{壊れたJSON' },
    });
    assert.ok(plain(h.app.S.suppliers).length >= 1, '初期データに戻っていない');
    assert.deepEqual(plain(h.app.S.order), {}, '発注書が空で始まっていない');
  });

  test('ジャンルが未設定の初期商品には自動で振られる', () => {
    const { app } = load();
    assert.equal(app.prod('p1').cat, 'お肉');
    assert.equal(app.prod('p4').cat, '野菜');
  });
});

describe('発注アプリ：発注書の増減', () => {
  test('入れる・外すで order と done が揃って動く', () => {
    const { app } = load();
    app.toggleProduct('p1');
    assert.equal(app.S.order.p1, 1, '入れた直後は1');
    assert.equal(app.orderCount(), 1);

    app.toggleDone('p1');
    assert.equal(app.S.done.p1, true);

    app.toggleProduct('p1');
    assert.equal(app.S.order.p1, undefined, '外しても order に残っている');
    assert.equal(app.S.done.p1, undefined, '外したのに done が残っている（買い物画面に幽霊が出る）');
  });

  test('数量を増やす・減らす', () => {
    const { app } = load();
    app.toggleProduct('p1');       // 1
    app.changeQty('p1', 1);        // 2
    app.changeQty('p1', 1);        // 3
    assert.equal(app.S.order.p1, 3);
    app.changeQty('p1', -1);       // 2
    assert.equal(app.S.order.p1, 2);
  });

  test('0以下にすると発注書から消える（マイナス在庫を作らない）', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.toggleDone('p1');
    app.changeQty('p1', -1);
    assert.equal(app.S.order.p1, undefined, '0なのに残っている');
    assert.equal(app.S.done.p1, undefined, 'done が残っている');
    assert.equal(app.orderCount(), 0);
  });

  test('発注書に無い品を「＋」すると2個で入る（現在の仕様）', () => {
    /* (S.order[pid] || 1) + 1 なので 1 ではなく 2 になる。
       直すかどうかは人の判断。いまの振るまいを記録しておく。 */
    const { app } = load();
    app.changeQty('p1', 1);
    assert.equal(app.S.order.p1, 2);
  });

  test('業者ごとの件数を数えられる', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.toggleProduct('p2');
    app.toggleProduct('p4');
    assert.equal(app.orderCount(), 3);
    assert.equal(app.orderCountBySup('s1'), 2);
    assert.equal(app.orderCountBySup('s2'), 1);
  });

  test('変更が localStorage に書かれる', () => {
    const { app, storage } = load();
    app.toggleProduct('p1');
    const saved = JSON.parse(storage._raw(LS_KEY));
    assert.equal(saved.order.p1, 1, '保存されていない（再読込で消える）');
  });

  test('保存が容量オーバーでも画面が死なない', () => {
    /* save() は try/catch で握りつぶす。«落ちない» ことだけを保証する。
       「保存できていないのに気づけない」件は別の課題（P1-1 と同種）。 */
    const { app } = load({ mode: 'quota' });
    assert.doesNotThrow(() => app.toggleProduct('p1'));
    assert.equal(app.S.order.p1, 1, '画面側の状態は進んでいる');
  });
});

describe('発注アプリ：並び順', () => {
  test('ピン留め→発注回数→名前の順に並ぶ', () => {
    const { app } = load();
    const names = plain(app.sortedProducts('s1')).map(p => p.name);
    assert.deepEqual(names, ['豚バラ', '鶏もも肉', '牛タン'],
      'ピン留めが先頭に来ていない、または発注回数の多い順になっていない');
  });

  test('他の業者の商品は混ざらない', () => {
    const { app } = load();
    assert.deepEqual(plain(app.sortedProducts('s2')).map(p => p.name), ['キャベツ']);
  });
});

describe('発注アプリ：発注文', () => {
  test('何も入っていなければ空文字を返す', () => {
    const { app } = load();
    assert.equal(app.buildOrderText('s1'), '', '空なのに文が作られた');
  });

  test('宛先・品目・結びが揃った文になる', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.changeQty('p1', 1);   // 2kg
    app.toggleProduct('p2');  // 1kg

    const t = app.buildOrderText('s1');
    assert.equal(t, [
      'いつもお世話になっております。',
      '串焼KEMURI屋です。',
      '12月31日（木）の注文をお願いします。',
      '',
      '・鶏もも肉　2kg',
      '・豚バラ　1kg',
      '',
      'よろしくお願いします!',
    ].join('\n'), '発注文の書式が変わっている');
  });

  test('指定した業者の品だけが入る', () => {
    const { app } = load();
    app.toggleProduct('p1');   // s1
    app.toggleProduct('p4');   // s2
    assert.match(app.buildOrderText('s1'), /鶏もも肉/);
    assert.doesNotMatch(app.buildOrderText('s1'), /キャベツ/, '他の業者の品が混ざった');
    assert.match(app.buildOrderText('s2'), /キャベツ　1玉/);
  });

  test('品目は発注書に入れた順に並ぶ', () => {
    const { app } = load();
    app.toggleProduct('p3');   // 牛タン を先に
    app.toggleProduct('p1');   // 鶏もも肉 を後に
    const lines = app.buildOrderText('s1').split('\n').filter(l => l.startsWith('・'));
    assert.deepEqual(lines, ['・牛タン　1kg', '・鶏もも肉　1kg']);
  });

  test('注文日は業者ごとに持つ', () => {
    const { app } = load();
    assert.equal(app.dateLabelFor('s1'), '12月31日（木）');
    app.S.supDates.s2 = '2099-03-05';
    assert.equal(app.dateLabelFor('s2'), '3月5日（木）');
    assert.equal(app.dateLabelFor('s1'), '12月31日（木）', '業者をまたいで日付が上書きされた');
  });

  test('注文日が過去なら明日に直す（古い日付で発注させない）', () => {
    const { app } = load();
    app.S.supDates.s1 = '2000-01-01';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(app.supDate('s1'), app.isoDate(tomorrow), '過去日のまま残っている');
  });
});

describe('発注アプリ：発注漏れ', () => {
  test('よく頼む品とピン留めの品が、発注書に無ければ挙がる', () => {
    const { app } = load();
    const names = plain(app.missingItems()).map(p => p.name);
    /* p1 freq5 / p2 pin / p4 freq4 が対象。p3 freq1 は対象外 */
    assert.deepEqual(names, ['豚バラ', '鶏もも肉', 'キャベツ']);
    assert.ok(!names.includes('牛タン'), '発注回数の少ない品まで «漏れ» にした');
  });

  test('発注書に入れたら挙がらなくなる', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.toggleProduct('p2');
    assert.deepEqual(plain(app.missingItems()).map(p => p.name), ['キャベツ']);
  });

  test('今日送信済みの業者は丸ごと外す', () => {
    const { app } = load();
    app.S.sentToday = { s1: app.todayStr() };
    assert.deepEqual(plain(app.missingItems()).map(p => p.name), ['キャベツ'],
      '送信済みの業者の品がまだ «漏れ» に出ている');
  });

  test('昨日の送信済みは効かない（日付で判定している）', () => {
    const { app } = load();
    app.S.sentToday = { s1: '2000/1/1' };
    assert.equal(plain(app.missingItems()).length, 3, '古い送信済みが残って漏れを隠した');
  });
});

describe('発注アプリ：送信と履歴', () => {
  test('送信すると履歴・発注回数・送信済みが揃って進む', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.changeQty('p1', 1);   // 2kg
    app.markSent('s1');

    const hist = plain(app.S.history);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].sid, 's1');
    assert.deepEqual(hist[0].items, [{ pid: 'p1', name: '鶏もも肉', unit: 'kg', qty: 2 }]);
    assert.equal(app.prod('p1').freq, 6, '発注回数が増えていない（並び順と発注漏れが育たない）');
    assert.equal(app.prod('p1').last, app.todayStr());
    assert.equal(app.S.sentToday.s1, app.todayStr());
  });

  test('空の業者を送信しても履歴は増えない', () => {
    const { app } = load();
    app.markSent('s1');
    assert.equal(plain(app.S.history).length, 0, '空の発注が履歴に残った');
    assert.equal(app.S.sentToday.s1, undefined);
  });

  test('送信しても発注書は消えない（買い物画面で使うため）', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.markSent('s1');
    assert.equal(app.S.order.p1, 1);
  });

  test('履歴は200件で打ち切る', () => {
    const state = fixture();
    state.history = Array.from({ length: 200 }, (_, i) => ({ date: '2026/1/1', sid: 's1', items: [], seq: i }));
    const { app } = load({ state });
    app.toggleProduct('p1');
    app.markSent('s1');
    const hist = plain(app.S.history);
    assert.equal(hist.length, 200, '履歴が無制限に増える（容量オーバーの原因）');
    assert.equal(hist[0].seq, 1, '古いほうから捨てていない');
    assert.equal(hist[199].sid, 's1');
    assert.equal(plain(hist[199].items).length, 1, '最後に積んだのが今回の分になっていない');
  });

  test('前回と同じ発注を呼び戻せる', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.changeQty('p1', 1);   // 2kg
    app.toggleProduct('p3');  // 1kg
    app.markSent('s1');

    app.S.order = {};
    app.copyLastOrder('s1');
    assert.deepEqual(plain(app.S.order), { p1: 2, p3: 1 }, '前回の数量どおりに戻っていない');
  });

  test('呼び戻しは «いま入っている品» を上書きしない', () => {
    const { app } = load();
    app.toggleProduct('p1');
    app.changeQty('p1', 1);   // 2kg
    app.markSent('s1');

    app.S.order = { p1: 9 };  // 今日は9kg にしてある
    app.copyLastOrder('s1');
    assert.equal(app.S.order.p1, 9, '手で入れた数量を前回の分で上書きした');
  });

  test('前回が無ければ知らせるだけ', () => {
    const h = load();
    h.app.copyLastOrder('s1');
    assert.deepEqual(plain(h.app.S.order), {});
    assert.ok(h.toasts.some(m => m.includes('前回の発注データ')), '知らせが出ていない');
  });

  test('他の業者の履歴は呼び戻さない', () => {
    const { app } = load();
    app.toggleProduct('p4');   // s2 の品
    app.markSent('s2');
    app.S.order = {};
    app.copyLastOrder('s1');
    assert.deepEqual(plain(app.S.order), {}, 's2 の履歴を s1 に流し込んだ');
  });
});
