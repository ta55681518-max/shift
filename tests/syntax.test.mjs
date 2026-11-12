/* 構文チェック：どのファイルも「開いた瞬間に真っ白」にならないことを守る。
   アプリはビルド無しなので、構文エラーはそのまま本番の白画面になる。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, read, listFiles, inlineScripts } from './helpers/env.mjs';

const JS_FILES = listFiles('.js');
const HTML_FILES = listFiles('.html');

describe('構文チェック', () => {
  test('共通JSが1本以上見つかる（テストが空振りしていない）', () => {
    assert.ok(JS_FILES.length >= 5, `JSが少なすぎる: ${JS_FILES.join(', ')}`);
    assert.ok(HTML_FILES.length >= 5, `HTMLが少なすぎる: ${HTML_FILES.join(', ')}`);
  });

  for (const f of JS_FILES) {
    test(`${f} の構文が通る`, () => {
      const code = read(f);
      assert.doesNotThrow(() => new vm.Script(code, { filename: f }));
    });
  }

  for (const f of HTML_FILES) {
    test(`${f} のインラインJSの構文が通る`, () => {
      const blocks = inlineScripts(read(f));
      blocks.forEach((b, i) => {
        assert.doesNotThrow(
          () => new vm.Script(b, { filename: `${f}#script${i}` }),
          `${f} の ${i} 番目のインラインscriptが壊れている`,
        );
      });
    });
  }

  test('Netlify Functions の構文が通る', () => {
    const dir = path.join(REPO, 'netlify', 'functions');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js')) : [];
    assert.ok(files.length >= 1, 'netlify/functions にJSが無い');
    for (const f of files) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotThrow(() => new vm.Script(code, { filename: `netlify/functions/${f}` }));
    }
  });

  for (const f of HTML_FILES) {
    test(`${f} の <script> タグが閉じている`, () => {
      const html = read(f);
      const open = (html.match(/<script\b/gi) || []).length;
      const close = (html.match(/<\/script>/gi) || []).length;
      assert.equal(open, close, `${f}: <script> ${open}個 / </script> ${close}個`);
    });
  }
});
