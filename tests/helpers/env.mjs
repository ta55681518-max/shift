/* ============================================================
   テスト用のブラウザ環境スタブ
   ------------------------------------------------------------
   アプリの共通JSは
     (function (global) { ... })(typeof window !== 'undefined' ? window : this)
   という形なので、localStorage を持った偽の window を vm に渡せば
   ブラウザ無しでそのまま動かせる。

   ・本番データには一切触らない（Map の上だけで動く）
   ・localStorage の «壊れ方» を切り替えられる
       ok          … ふつう
       quota       … setItem が QuotaExceededError を投げる
       silentFail  … setItem は通るが、実際には書かれない（読み戻すと前の値）
       readError   … getItem が例外を投げる
     → 「保存できたと思ったら保存できていなかった」を再現するための装置。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const REPO = path.resolve(import.meta.dirname, '..', '..');

/* アプリが使う localStorage キー（凍結リスト）。
   ここを増減させる変更は «保存形式の変更» なので、
   config.test.mjs と backup-roundtrip.test.mjs で検査される。 */
export const APP_KEYS = Object.freeze([
  'kemuri_reitou_v1',
  'kemuri_sales_v1',
  'kemuri_daily_v1',
  'kemuri_costs_v1',
  'kemuri_recipes_v1',
  'kemuri_zaiko_v1',
  'kemuri_kushiyaki_v1',
  'kemuri_hacchu_v1',
]);

class QuotaExceededError extends Error {
  constructor() {
    super('QuotaExceededError');
    this.name = 'QuotaExceededError';
    this.code = 22;
  }
}

/** Map を下敷きにした localStorage。mode で壊れ方を変えられる */
export function makeStorage(initial = {}, mode = 'ok') {
  const store = new Map(Object.entries(initial).map(([k, v]) => [String(k), String(v)]));
  const api = {
    mode,
    /** テストから中身を直接のぞく・書きかえる（別タブの操作を模す） */
    _store: store,
    _raw(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
    _set(key, value) { store.set(String(key), String(value)); },
    _snapshot() { return Object.fromEntries(store); },

    getItem(key) {
      if (api.mode === 'readError') throw new Error('SecurityError');
      const k = String(key);
      return store.has(k) ? store.get(k) : null;
    },
    setItem(key, value) {
      if (api.mode === 'quota') throw new QuotaExceededError();
      if (api.mode === 'silentFail') return;   // 書いたふりをする
      store.set(String(key), String(value));
    },
    removeItem(key) {
      if (api.mode === 'quota') throw new QuotaExceededError();
      store.delete(String(key));
    },
    clear() { store.clear(); },
    key(i) { return [...store.keys()][i] ?? null; },
    get length() { return store.size; },
  };
  return api;
}

/**
 * 共通JSを読み込んだ «偽ブラウザ» を作る。
 * @param {object} opts
 * @param {string[]} opts.files   読み込むJSファイル名（順番どおりに評価）
 * @param {object}   opts.initial localStorage の初期値
 * @param {string}   opts.mode    localStorage の壊れ方
 * @returns sandbox（KemuriCore / KemuriData / KemuriBackup などが乗っている）
 */
export function loadApp({ files = ['kemuri-core.js'], initial = {}, mode = 'ok' } = {}) {
  const localStorage = makeStorage(initial, mode);
  const sandbox = {
    localStorage,
    console,
    /* アプリが触りうる最小限のブラウザAPI。実装は «何もしない» */
    navigator: { share: undefined, clipboard: undefined, canShare: undefined },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, URL, Blob: undefined, File: undefined,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const f of files) {
    const code = fs.readFileSync(path.join(REPO, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  sandbox.__storage = localStorage;
  return sandbox;
}

/** 「売上履歴＋原価・レシピ・分析」まで一式入った環境 */
export function loadFull(opts = {}) {
  return loadApp({
    files: ['kemuri-core.js', 'kemuri-backup.js', 'pos-source.js', 'kemuri-data.js'],
    ...opts,
  });
}

/* vm の中で作られた配列・オブジェクトは «別の世界の Array» なので、
   assert.deepEqual が prototype 違いで落ちる。値だけこちら側に写して比べる。 */
export function plain(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/** リポジトリ内のファイルを読む（存在しなければ null） */
export function read(rel) {
  const p = path.join(REPO, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** リポジトリ直下のアプリ関連ファイル一覧 */
export function listFiles(ext) {
  return fs.readdirSync(REPO)
    .filter(f => f.endsWith(ext))
    .sort();
}

/** HTMLから「srcの無い」<script> の中身だけを取り出す */
export function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .filter(s => s.trim());
}
