/* セキュリティ：AIが勝手に «鍵を漏らす» / «新しい外部送信先を足す» のを止める。
   ここが落ちたらマージしない。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, read, listFiles } from './helpers/env.mjs';

/* ブラウザに配られるファイル（＝誰でも中身が見える） */
const CLIENT_FILES = [...listFiles('.js'), ...listFiles('.html')];

/* クライアント側から通信してよい相手。ここに無いホストが現れたらテストを落とす。
   新しい送信先を足すのは «人間が承認する変更» であって、AIの自動マージ対象ではない。 */
const ALLOWED_HOSTS = Object.freeze([
  'comfy-khapse-8a3cae.netlify.app',  // 自分の本番URL
  'script.google.com',                 // シフト希望・予約・串在庫共有のGAS
  'line.me',                           // LINE共有スキーム
  'developers.line.biz',               // コメント内のドキュメントURL
]);

/* 本物の鍵らしい文字列。コメント中の «変数名» は引っかからないようにしてある */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic APIキー'],
  [/sk-proj-[A-Za-z0-9_-]{10,}/, 'OpenAI プロジェクトキー'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI APIキー'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'GitHub Personal Access Token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'GitHub PAT (fine-grained)'],
  [/\bwhsec_[A-Za-z0-9]{20,}\b/, 'Webhook signing secret'],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/, 'Google APIキー'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, '秘密鍵'],
];

function allRepoFiles() {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'test-results', 'playwright-report']);
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (/\.(js|mjs|cjs|html|json|toml|gs|md|yml|yaml)$/i.test(e.name)) out.push(r);
    }
  })(REPO, '');
  return out;
}

describe('セキュリティ', () => {
  test('リポジトリ内に鍵・トークンが混入していない', () => {
    const hits = [];
    for (const rel of allRepoFiles()) {
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const [re, label] of SECRET_PATTERNS) {
        const m = text.match(re);
        if (m) hits.push(`${rel}: ${label}（${m[0].slice(0, 12)}…）`);
      }
    }
    assert.deepEqual(hits, [], `鍵らしい文字列が見つかった:\n${hits.join('\n')}`);
  });

  test('クライアント側のファイルが process.env を読んでいない', () => {
    const hits = CLIENT_FILES.filter(f => /process\s*\.\s*env/.test(read(f)));
    assert.deepEqual(hits, [], `ブラウザ側で process.env を読もうとしている: ${hits.join(', ')}`);
  });

  test('クライアント側の通信先が許可リストの中だけ', () => {
    const found = new Map();
    for (const f of CLIENT_FILES) {
      for (const m of read(f).matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        if (!found.has(m[1])) found.set(m[1], f);
      }
    }
    const unknown = [...found.entries()]
      .filter(([host]) => !ALLOWED_HOSTS.includes(host))
      .map(([host, f]) => `${host}（${f}）`);
    assert.deepEqual(unknown, [],
      `許可していない通信先が増えている:\n${unknown.join('\n')}\n` +
      '→ 外部送信先の追加は人間の承認が必要。意図した追加なら tests/security.test.mjs の ALLOWED_HOSTS に追記すること。');
  });

  test('Netlify Function が鍵を環境変数からだけ読んでいる', () => {
    const code = read('netlify/functions/ai.js');
    assert.ok(code, 'netlify/functions/ai.js が無い');
    assert.match(code, /process\.env\.OPENAI_API_KEY/, 'OPENAI_API_KEY を環境変数から読んでいない');
    assert.match(code, /process\.env\.KEMURI_PASS/, 'KEMURI_PASS を環境変数から読んでいない');
    /* 合言葉が一致しないと門前払いする仕組みが残っているか */
    assert.match(code, /x-kemuri-pass/i, '合言葉ヘッダの検査が消えている');
    assert.match(code, /statusCode:\s*401|json\(401/, '認証失敗時の401が消えている');
  });

  test('Netlify Function が「決まった依頼」以外を受け付けない', () => {
    const code = read('netlify/functions/ai.js');
    /* TASKS に無い task は弾く作りを維持する（自由な文章を投げられないようにする） */
    assert.match(code, /const\s+TASKS\s*=/, 'TASKS のホワイトリストが消えている');
    assert.match(code, /知らない依頼|unknown task/i, '未知のtaskを弾く分岐が消えている');
  });

  test('ワークフローが pull_request_target を使っていない', () => {
    const dir = path.join(REPO, '.github', 'workflows');
    if (!fs.existsSync(dir)) return;
    const hits = [];
    for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x))) {
      const y = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/pull_request_target/.test(y)) hits.push(f);
    }
    assert.deepEqual(hits, [],
      `pull_request_target はフォークのPRにシークレットを渡してしまう: ${hits.join(', ')}`);
  });

  test('ワークフローが危険な権限を要求していない', () => {
    const dir = path.join(REPO, '.github', 'workflows');
    if (!fs.existsSync(dir)) return;
    const hits = [];
    for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x))) {
      const y = fs.readFileSync(path.join(dir, f), 'utf8');
      /* administration = リポジトリ設定の変更権限。AIに渡さない。
         actions: write = ワークフロー自体の書き換え権限。渡さない。 */
      if (/^\s*administration:\s*write/m.test(y)) hits.push(`${f}: administration: write`);
      if (/^\s*actions:\s*write/m.test(y)) hits.push(`${f}: actions: write`);
      if (/secrets\.GITHUB_PAT|secrets\.PAT\b/.test(y)) hits.push(`${f}: 個人PATを使っている`);
    }
    assert.deepEqual(hits, [], `AIに渡してはいけない権限がある:\n${hits.join('\n')}`);
  });
});
