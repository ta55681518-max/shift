/* ============================================================
   既知の未修正点（実行可能なバックログ）
   ------------------------------------------------------------
   todo: true を付けているので、落ちても CI は赤にならない。
   「直ったら todo を外す」ことで、修正が本当に効いたことを証明する。

   自動開発ワークフローは automation/backlog.md とこのファイルを見て
   次の作業を決める。優先度は backlog.md 側に書いてある。
   ============================================================ */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFull, loadApp, plain, read } from './helpers/env.mjs';

describe('Phase 1：データ保護の未修正点', () => {
  test('[P1-1] 原価マスタの保存が失敗を検出する', { todo: '読み戻し検証が未実装（writeLS が例外しか見ていない）' }, () => {
    const { KemuriData } = loadFull({ mode: 'silentFail' });
    const ok = KemuriData.costs.set('もも', { price: 84, sale: 220 });
    assert.equal(ok, false, '書けていないのに true を返した');
  });

  test('[P1-2] レシピの保存が失敗を検出する', { todo: '読み戻し検証が未実装' }, () => {
    const { KemuriData } = loadFull({ mode: 'silentFail' });
    const ok = KemuriData.recipes.set('もも串', [{ name: '鶏もも肉', qty: 80, unit: 'g' }]);
    assert.equal(ok, false, '書けていないのに true を返した');
  });


  test('[P1-4] 原価マスタが別タブの変更を検出する', { todo: '競合検出が未実装（kemuri_costs_v1 は last-write-wins）' }, () => {
    const a = loadFull();
    a.KemuriData.costs.set('もも', { price: 84 });
    a.KemuriData.costs.load();
    /* 別タブが先に書いた */
    a.__storage._set('kemuri_costs_v1', JSON.stringify({ v: 1, items: { 'ねぎま': { name: 'ねぎま', price: 90 } }, updatedAt: 'other' }));
    a.KemuriData.costs.set('もも', { price: 85 });
    assert.match(a.__storage._raw('kemuri_costs_v1'), /ねぎま/, '別タブの内容を上書きした');
  });

  test('[P1-5] バックアップに共有URLが含まれる', { todo: 'kemuri_kushiyaki_share が KEYS に無い（端末を替えると共有に再接続できない）' }, () => {
    const a = loadApp({ files: ['kemuri-core.js', 'kemuri-backup.js'] });
    assert.ok(plain(a.KemuriBackup.KEYS).includes('kemuri_kushiyaki_share'));
  });

  test('[P1-6] バックアップの一覧に串在庫・発注の件数が出る', { todo: 'describe() が「あり」としか返さない' }, () => {
    const a = loadApp({
      files: ['kemuri-core.js', 'kemuri-backup.js'],
      initial: {
        kemuri_kushiyaki_v1: JSON.stringify({ items: { もも: { lots: [{ id: 1, qty: 25 }] } } }),
        kemuri_hacchu_v1: JSON.stringify({ suppliers: [{ id: 's1', name: '丸大' }], products: [] }),
      },
    });
    const list = plain(a.KemuriBackup.summary(a.KemuriBackup.collect()));
    const k = list.find(x => x.key === 'kemuri_kushiyaki_v1');
    assert.notEqual(k.detail, 'あり', '串在庫の件数が出ていない');
  });
});

describe('Phase 2：整合性の未修正点', () => {
  test('[P2-1] site-notice.js の ?v= が全ファイルで揃っている', { todo: '20261008a と 20261012b が混在' }, () => {
    const versions = new Set();
    for (const f of ['index.html', 'order.html', 'hacchu.html', 'dashboard.html', 'kushiyaki.html', 'reitou.html', 'reitou-button.html']) {
      const html = read(f);
      if (!html) continue;
      const m = html.match(/src="site-notice\.js\?v=([0-9a-z]+)"/);
      if (m) versions.add(m[1]);
    }
    assert.equal(versions.size, 1, `?v= が揃っていない: ${[...versions].join(' / ')}`);
  });

  test('[P2-2] 版表示の規約どおり ?v= と BUILD が揃っている', { todo: '?v=20261026r1 なのに BUILD は 2026-10-12b' }, () => {
    const build = read('kemuri-data.js').match(/BUILD:\s*'([^']+)'/)[1];
    const v = read('dashboard.html').match(/src="kemuri-data\.js\?v=([0-9a-z]+)"/)[1];
    assert.equal(v, build.replace(/-/g, ''), `?v=${v} と BUILD=${build} が対応していない`);
  });

  test('[P2-3] 串在庫にも版表示がある', { todo: 'kushiyaki.html に HTML_BUILD が無く「古いJSが残っている」を見分けられない' }, () => {
    assert.match(read('kushiyaki.html'), /HTML_BUILD/);
  });

  test('[P2-4] 発注の版表示がある', { todo: 'hacchu.html に HTML_BUILD が無い' }, () => {
    assert.match(read('hacchu.html'), /HTML_BUILD/);
  });

  test('[P2-5] 冷凍在庫の it.cost が使われている', { todo: '0 を埋めるだけで未使用（原価は kemuri_costs_v1 へ移行済みの残骸）' }, () => {
    /* migrate の初期化行（it.cost == null / it.cost = 0）を除いて数える */
    const uses = read('reitou.html').split(/\r?\n/)
      .filter(l => /\.cost\b/.test(l) && !/it\.cost == null|it\.cost = 0/.test(l)).length;
    assert.ok(uses >= 1, `it.cost が初期化以外で使われていない（該当行 ${uses} 行）`);
  });


  test('[P2-7] 発注アプリから他アプリへ戻れる', { todo: 'hacchu.html に他アプリへのリンクが0件' }, () => {
    assert.match(read('hacchu.html'), /href="(dashboard|reitou|kushiyaki)\.html"/);
  });
});

describe('Phase 3：串在庫の共有（GAS変更が必要なため個別承認制）', () => {
  test('[P3-1] 共有の競合検出が効いている', { todo: 'クライアントは baseRev を送るが GAS 側が無視している。GAS貼り替えはオーナー承認が必要' }, () => {
    const src = read('kushiyaki.html');
    const gas = src.match(/const GAS_SRC = `([\s\S]*?)`;/);
    assert.ok(gas, 'GAS_SRC が見つからない');
    assert.match(gas[1], /baseRev/, 'GAS 側が baseRev を見ていない');
  });

  test('[P3-2] 共有JSONの大きさを画面に出している', { todo: 'Googleスプレッドシートのセル上限5万文字に当たる前に警告が出ない' }, () => {
    assert.match(read('kushiyaki.html'), /50000|5万|セル上限|sizeWarn/);
  });
});
