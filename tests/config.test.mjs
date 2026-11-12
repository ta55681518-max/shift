/* 設定の整合：保存形式・配信設定・版番号。
   ここは «壊れると本番のデータが読めなくなる» 側の守り。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { read, listFiles, APP_KEYS } from './helpers/env.mjs';

describe('netlify.toml', () => {
  const toml = read('netlify.toml');

  test('存在して、ビルド無し構成のまま', () => {
    assert.ok(toml, 'netlify.toml が無い');
    assert.match(toml, /publish\s*=\s*"\."/, 'publish が "." でない（配信ルートが変わっている）');
    assert.match(toml, /functions\s*=\s*"netlify\/functions"/, 'functions の場所が変わっている');
  });

  test('/api/* → Functions のリダイレクトが生きている', () => {
    assert.match(toml, /from\s*=\s*"\/api\/\*"/, '/api/* のリダイレクトが消えている');
    assert.match(toml, /to\s*=\s*"\/\.netlify\/functions\/:splat"/, 'リダイレクト先が変わっている');
    assert.match(toml, /status\s*=\s*200/, 'リダイレクトの status が 200 でない');
  });

  test('HTML/JS のキャッシュ無効化が生きている（古い画面が残らないように）', () => {
    assert.match(toml, /for\s*=\s*"\/\*\.html"/, 'HTMLのキャッシュ設定が消えている');
    assert.match(toml, /for\s*=\s*"\/\*\.js"/, 'JSのキャッシュ設定が消えている');
    assert.match(toml, /must-revalidate/, 'must-revalidate が消えている');
  });
});

describe('保存形式（localStorage キー）', () => {
  /* アプリが実際に触っているキーを総ざらいして、凍結リストと突き合わせる。
     キー名を変えると、オーナーの端末に貯まっている実データが «無かったこと» になる。
     だからこの検査は自動マージの必須条件。 */
  const files = [...listFiles('.js'), ...listFiles('.html')];
  const found = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/'(kemuri_[a-z0-9_]+)'/g)) found.add(m[1]);
    for (const m of read(f).matchAll(/"(kemuri_[a-z0-9_]+)"/g)) found.add(m[1]);
  }

  test('アプリ本体のキーが1つも消えていない', () => {
    const missing = APP_KEYS.filter(k => !found.has(k));
    assert.deepEqual(missing, [],
      `localStorage キーが見つからない: ${missing.join(', ')}\n` +
      '→ 保存形式の変更は人間の承認が必要。自動マージしてはいけない。');
  });

  test('知らないキーが勝手に増えていない', () => {
    /* アプリ本体の8キー以外で、現状使われている補助キー */
    const KNOWN_EXTRA = [
      'kemuri_zaiko_snapshot',       // 旧zaikoの控え（読み取りのみ）
      'kemuri_kushiyaki_share',      // 串在庫の共有URL
      'kemuri_pos_source',           // POS取得元の選択
      'kemuri_ai_pass',              // AIの合言葉（端末のみ）
      'kemuri_ai_cache_v1',          // AI返答の控え
      /* localStorage キーではないが、同じ綴りで現れるもの */
      'kemuri_hacchu',               // hacchu.html のバックアップJSONの app 識別子
    ];
    const allowed = new Set([...APP_KEYS, ...KNOWN_EXTRA]);
    const unknown = [...found].filter(k => !allowed.has(k));
    assert.deepEqual(unknown, [],
      `新しい localStorage キーが増えている: ${unknown.join(', ')}\n` +
      '→ 保存形式の追加は人間の承認が必要。意図した追加なら tests/config.test.mjs に追記すること。');
  });
});

describe('版番号の整合', () => {
  /* 「画面は新しいのに中身が古い」を見分けるための版表示。
     ?v= と BUILD がズレると、この検出が効かなくなる。 */
  test('dashboard.html の HTML_BUILD と KemuriData.BUILD が一致', () => {
    const html = read('dashboard.html').match(/HTML_BUILD\s*=\s*'([^']+)'/);
    const data = read('kemuri-data.js').match(/BUILD:\s*'([^']+)'/);
    assert.ok(html, 'dashboard.html に HTML_BUILD が無い');
    assert.ok(data, 'kemuri-data.js に BUILD が無い');
    assert.equal(html[1], data[1],
      `版がズレている: dashboard.html=${html[1]} / kemuri-data.js=${data[1]}`);
  });

  test('reitou.html の HTML_BUILD も同じ', () => {
    const r = read('reitou.html').match(/HTML_BUILD\s*=\s*'([^']+)'/);
    const data = read('kemuri-data.js').match(/BUILD:\s*'([^']+)'/);
    assert.equal(r[1], data[1],
      `版がズレている: reitou.html=${r[1]} / kemuri-data.js=${data[1]}`);
  });

  test('kemuri-core.js と kemuri-data.js の ?v= が全ファイルで揃っている', () => {
    const bad = [];
    for (const js of ['kemuri-core.js', 'kemuri-data.js']) {
      const versions = new Set();
      for (const f of listFiles('.html')) {
        const m = read(f).match(new RegExp(`src="${js.replace('.', '\\.')}\\?v=([0-9a-z]+)"`));
        if (m) versions.add(m[1]);
      }
      if (versions.size > 1) bad.push(`${js}: ${[...versions].join(' / ')}`);
    }
    assert.deepEqual(bad, [],
      `同じJSに複数の ?v= が指定されている（キャッシュが揃わない）:\n${bad.join('\n')}`);
  });
});

describe('アプリ間の参照', () => {
  test('リンク先のHTMLが実在する', () => {
    const existing = new Set(listFiles('.html'));
    const broken = [];
    for (const f of listFiles('.html')) {
      for (const m of read(f).matchAll(/href="\.?\/?([a-z0-9-]+\.html)"/g)) {
        if (!existing.has(m[1])) broken.push(`${f} → ${m[1]}`);
      }
    }
    assert.deepEqual(broken, [], `リンク切れ:\n${broken.join('\n')}`);
  });

  test('読み込んでいる共通JSが実在する', () => {
    const existing = new Set(listFiles('.js'));
    const broken = [];
    for (const f of listFiles('.html')) {
      for (const m of read(f).matchAll(/src="([a-z0-9-]+\.js)(\?[^"]*)?"/g)) {
        if (!existing.has(m[1])) broken.push(`${f} → ${m[1]}`);
      }
    }
    assert.deepEqual(broken, [], `読み込めないJS:\n${broken.join('\n')}`);
  });
});
