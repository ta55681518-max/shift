/* ============================================================
   HTML に直接書かれたアプリ（hacchu.html / order.html など）を
   ブラウザ無しで動かすための足場。
   ------------------------------------------------------------
   共通JS（kemuri-*.js）は helpers/env.mjs で読めるが、
   発注・オードブル予約は «HTMLの中の <script>» に本体があるので
   そのままでは単体テストできない。ここがその差を埋める。

   やっていること
     1. HTML から src の無い <script> を取り出す
     2. 末尾の起動行（render(); / init();）だけを取り除く
        → 画面を作らずに «関数だけ» 読み込める
     3. 画面の代わりになる最小の document を渡す
     4. HTML の中で let / const で宣言された変数（S や INFO）は
        vm の外から見えないので、同じスクリプトの末尾に
        getter/setter を足して取り出せるようにする

   «1. の起動行が見つからない» ときはテストを失敗させる。
   HTML 側の作りが変わったことに気づかず
   «中身を読まずに緑» になるのを防ぐため。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO, makeStorage, inlineScripts } from './env.mjs';

/** 画面の要素のふり。textContent などを «置ける» だけの入れ物 */
function makeElement(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    src: '',
    href: '',
    disabled: false,
    checked: false,
    className: '',
    id: '',
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    appendChild(child) { el.children.push(child); return child; },
    removeChild(child) { el.children = el.children.filter(x => x !== child); return child; },
    insertBefore(child) { el.children.unshift(child); return child; },
    remove() {},
    select() {},
    focus() {},
    blur() {},
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
  return el;
}

/** getElementById が «必ず何か返す» 偽の document */
function makeDocument() {
  const byId = new Map();
  const body = makeElement('body');
  return {
    body,
    documentElement: makeElement('html'),
    getElementById(id) {
      const k = String(id);
      if (!byId.has(k)) { const e = makeElement(); e.id = k; byId.set(k, e); }
      return byId.get(k);
    },
    createElement(tag) { return makeElement(tag); },
    createTextNode(t) { const e = makeElement('#text'); e.textContent = t; return e; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    execCommand() { return true; },
    addEventListener() {},
    removeEventListener() {},
    /** テストから「入力欄に値を入れる」ために使う */
    _ids: byId,
  };
}

/**
 * HTML の中のアプリを読み込む。
 * @param {object}   opts
 * @param {string}   opts.file      リポジトリ直下のHTMLファイル名
 * @param {string}   opts.bootstrap 末尾の起動行の関数名（例 'render' / 'init'）
 * @param {string[]} opts.expose    外から読み書きしたい変数・関数の名前
 * @param {object}   opts.initial   localStorage の初期値
 * @param {string}   opts.mode      localStorage の壊れ方（env.mjs と同じ）
 * @returns {{app:object, storage:object, document:object, sandbox:object}}
 *          app … expose した名前が getter/setter で生えたオブジェクト
 */
export function loadHtmlApp({ file, bootstrap, expose = [], initial = {}, mode = 'ok' } = {}) {
  const html = fs.readFileSync(path.join(REPO, file), 'utf8');
  const blocks = inlineScripts(html);
  if (!blocks.length) throw new Error(`${file} に src 無しの <script> が無い`);

  /* 起動行は «スクリプトの最後の行» と決め打つ。
     同じ呼び出しが関数の中にもある（hacchu.html の go() が render() を呼ぶ）ので、
     «何個あるか» では区別できない。 */
  const bootRe = new RegExp(`^[ \\t]*${bootstrap}\\(\\);?[ \\t]*$`);
  let body = null;
  let lines = null;
  let lastIdx = -1;
  for (const b of blocks) {
    const ls = b.split(/\r?\n/);
    let i = ls.length - 1;
    while (i >= 0 && ls[i].trim() === '') i--;
    if (i >= 0 && bootRe.test(ls[i])) { body = b; lines = ls; lastIdx = i; break; }
  }
  if (!body) {
    throw new Error(
      `${file} の <script> の末尾が "${bootstrap}();" になっていない。` +
      'HTML 側の作りが変わった可能性がある（テストの前提が崩れている）',
    );
  }
  lines[lastIdx] = '/* 起動行はテストでは実行しない */';
  const code = lines.join('\n');

  const localStorage = makeStorage(initial, mode);
  const documentStub = makeDocument();
  const sandbox = {
    localStorage,
    document: documentStub,
    console,
    navigator: { clipboard: undefined, share: undefined, canShare: undefined, userAgent: 'node' },
    location: { href: '', reload() {} },
    /* 通信は «つながらない» 固定。テストが外に出ないようにする */
    fetch: () => Promise.reject(new Error('fetch はテストでは使えない')),
    alert() {}, confirm: () => false, prompt: () => null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, URL, TextDecoder, TextEncoder,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.scrollTo = () => {};
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);

  /* HTML の let / const は vm の外から見えないので、
     同じスクリプトの末尾で getter/setter に包んで公開する */
  const bridge = expose
    .map(n => `  get ${n}(){ return ${n}; }, set ${n}(v){ ${n} = v; },`)
    .join('\n');
  const epilogue = `\n;globalThis.__app = {\n${bridge}\n};\n`;

  vm.runInContext(code + epilogue, sandbox, { filename: file });

  return {
    app: sandbox.__app,
    storage: localStorage,
    document: documentStub,
    sandbox,
  };
}

/**
 * 画面を書き換える関数を «記録するだけ» の関数に差し替える。
 * 画面作りを巻き込まずにロジックだけ試すため。
 * @returns {string[]} 呼ばれた順に文字列が入る配列（toast の文など）
 */
export function stubCalls(sandbox, names) {
  const log = [];
  for (const n of names) {
    sandbox[n] = (...args) => { log.push(`${n}:${args.map(a => String(a)).join(',')}`); };
  }
  return log;
}
