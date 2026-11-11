/* ============================================================
   GitHub Actions ワークフローの検査
   ------------------------------------------------------------
   YAMLパーサを入れずに、実際に壊れやすいところだけを確かめる。
     ・jobs / needs / outputs の相互参照が合っているか
     ・${{ }} が閉じているか
     ・run: | の中のヒアドキュメントが正しい深さか
     ・AIに渡してはいけない権限が無いか
     ・main への push・本番公開を自動化していないか
   ============================================================ */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers/env.mjs';

const DIR = path.join(REPO, '.github', 'workflows');
const FILES = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).sort()
  : [];

function load(f) {
  return fs.readFileSync(path.join(DIR, f), 'utf8');
}

/* jobs: 直下（2スペース）のキーを job 名として拾う */
function jobNames(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line) && line.trim()) break;            // トップレベルに戻った
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/* 各 job が宣言している outputs のキー */
function jobOutputs(text) {
  const map = {};
  const lines = text.split(/\r?\n/);
  let job = null, inOutputs = false;
  for (const line of lines) {
    const j = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (j) { job = j[1]; map[job] = map[job] || []; inOutputs = false; continue; }
    if (!job) continue;
    if (/^ {4}outputs:\s*$/.test(line)) { inOutputs = true; continue; }
    if (inOutputs) {
      const o = line.match(/^ {6}([A-Za-z0-9_-]+):/);
      if (o) map[job].push(o[1]);
      else if (/^ {4}\S/.test(line)) inOutputs = false;
    }
  }
  return map;
}

describe('ワークフローの存在', () => {
  test('必要なワークフローが揃っている', () => {
    for (const f of ['test.yml', 'claude-daily.yml', 'claude-mention.yml', 'smoke-production.yml']) {
      assert.ok(FILES.includes(f), `${f} が無い`);
    }
  });
});

for (const f of FILES) {
  describe(`${f}`, () => {
    const text = load(f);

    test('タブ文字を使っていない（YAMLでは致命的）', () => {
      const i = text.split(/\r?\n/).findIndex(l => /^\t| \t/.test(l));
      assert.equal(i, -1, `${i + 1} 行目にタブ文字がある`);
    });

    test('name / on / jobs / permissions がある', () => {
      assert.match(text, /^name:/m, 'name が無い');
      assert.match(text, /^on:/m, 'on が無い');
      assert.match(text, /^jobs:/m, 'jobs が無い');
      assert.match(text, /^permissions:|^ {4}permissions:/m, 'permissions の宣言が無い（最小権限を明示する）');
    });

    test('${{ }} が閉じている', () => {
      const open = (text.match(/\$\{\{/g) || []).length;
      const close = (text.match(/\}\}/g) || []).length;
      assert.equal(open, close, `\${{ が ${open}個 / }} が ${close}個`);
    });

    test('needs が実在する job を指している', () => {
      const names = new Set(jobNames(text));
      const bad = [];
      for (const m of text.matchAll(/^ {4}needs:\s*\[([^\]]*)\]/gm)) {
        for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
          if (!names.has(n)) bad.push(n);
        }
      }
      for (const m of text.matchAll(/^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/gm)) {
        if (!names.has(m[1])) bad.push(m[1]);
      }
      assert.deepEqual(bad, [], `存在しない job を needs している: ${bad.join(', ')}`);
    });

    test('needs.<job>.outputs.<key> が宣言済みのものだけ', () => {
      const outs = jobOutputs(text);
      const bad = [];
      for (const m of text.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
        const [, job, key] = m;
        if (!outs[job]) bad.push(`${job}（job が無い）`);
        else if (!outs[job].includes(key)) bad.push(`${job}.${key}（outputs に宣言が無い）`);
      }
      assert.deepEqual([...new Set(bad)], [], `参照できない outputs: ${[...new Set(bad)].join(', ')}`);
    });

    test('run: | の中のヒアドキュメントが閉じている', () => {
      const lines = text.split(/\r?\n/);
      const opens = [];
      for (let i = 0; i < lines.length; i++) {
        const o = lines[i].match(/<<-?\s*'?([A-Z][A-Z0-9_]*)'?/);
        if (o) opens.push({ tag: o[1], line: i + 1 });
      }
      for (const { tag, line } of opens) {
        /* 同じタグが «行頭のみ»（インデント除去後に単独で現れる）で閉じられているか */
        const closed = lines.some((l, idx) => idx > line - 1 && new RegExp(`^\\s*${tag}\\s*$`).test(l));
        assert.ok(closed, `${line} 行目の <<${tag} が閉じられていない`);
      }
    });

    test('pull_request_target を使っていない', () => {
      assert.doesNotMatch(text, /pull_request_target/,
        'フォークのPRにシークレットが渡るため使ってはいけない');
    });

    test('AIに渡してはいけない権限が無い', () => {
      assert.doesNotMatch(text, /^\s*administration:\s*write/m, 'administration: write がある');
      assert.doesNotMatch(text, /^\s*actions:\s*write/m, 'actions: write がある（ワークフロー自体を書き換えられる）');
      assert.doesNotMatch(text, /secrets\.(GITHUB_PAT|PAT|GH_PAT)\b/, '個人PATを使っている');
    });

    test('timeout-minutes が全 job に付いている（暴走の歯止め）', () => {
      const names = jobNames(text);
      const count = (text.match(/^ {4}timeout-minutes:/gm) || []).length;
      assert.ok(count >= names.length,
        `job ${names.length}個 に対して timeout-minutes が ${count}個しか無い`);
    });
  });
}

describe('安全条件：本番への自動反映をしていない', () => {
  test('main への push を自動化していない', () => {
    for (const f of FILES) {
      const t = load(f);
      assert.doesNotMatch(t, /git push[^\n]*\bmain\b/, `${f}: main への push がある`);
      assert.doesNotMatch(t, /gh pr merge[^\n]*--base\s+main/, `${f}: main への自動マージがある`);
    }
  });

  test('自動マージの対象が develop に限定されている', () => {
    const t = load('test.yml');
    assert.match(t, /github\.base_ref == 'develop'/, '自動マージが develop 限定になっていない');
    assert.match(t, /gh pr merge/, '自動マージの処理が無い');
  });

  test('Netlify へのデプロイコマンドを自動実行していない', () => {
    for (const f of FILES) {
      const t = load(f);
      assert.doesNotMatch(t, /netlify\s+deploy/, `${f}: netlify deploy がある`);
      assert.doesNotMatch(t, /netlify-cli/, `${f}: netlify-cli を使っている`);
    }
  });

  test('本番URLに対して GET 以外を投げていない（スモークの ping を除く）', () => {
    const t = load('smoke-production.yml');
    /* /api/ai への POST は «認証が効いているか» の確認なので許可。
       それ以外の書き込み系が無いことを確かめる */
    const posts = [...t.matchAll(/-X\s+(POST|PUT|PATCH|DELETE)/g)].map(m => m[1]);
    assert.deepEqual(posts, ['POST'], `想定外の書き込みメソッド: ${posts.join(', ')}`);
    assert.match(t, /task":"ping"/, 'POST が ping 以外に使われている可能性');
  });
});

describe('安全条件：費用と回数の上限', () => {
  test('毎日の自動開発に月あたりの実行上限がある', () => {
    const t = load('claude-daily.yml');
    assert.match(t, /MONTHLY_RUN_LIMIT:\s*\d+/, '月あたりの実行上限が無い');
    assert.match(t, /--max-turns\s+\d+/, 'max-turns の上限が無い');
    assert.match(t, /concurrency:/, '同時実行の制限が無い');
  });

  test('モデルが明示されている（高いモデルに勝手に振れない）', () => {
    const ALLOWED = ['claude-sonnet-5', 'claude-opus-5'];
    for (const f of ['claude-daily.yml', 'claude-mention.yml']) {
      const t = load(f);
      assert.match(t, /--model\s+(claude-|\$\{\{)/, `${f}: --model の指定が無い`);
      assert.ok(t.includes('claude-sonnet-5'), `${f}: 既定モデルが claude-sonnet-5 になっていない`);
      /* 許可していないモデル名が混ざっていないか */
      /* モデル名だけを拾う（ワークフロー名や concurrency 名を誤検出しないように） */
      const used = [...new Set([...t.matchAll(/claude-(?:sonnet|opus|haiku|fable|mythos)[a-z0-9.-]*/g)].map(m => m[0]))];
      const bad = used.filter(m => !ALLOWED.includes(m));
      assert.deepEqual(bad, [], `${f}: 許可していないモデルが指定されている: ${bad.join(', ')}`);
    }
  });

  test('@claude の起動が書き込み権限者に限定されている', () => {
    const t = load('claude-mention.yml');
    assert.match(t, /author_association == 'OWNER'/, 'オーナー限定の条件が無い');
    /* 入力キーとして使われていないこと（コメント内の言及は許す） */
    assert.doesNotMatch(t, /^\s*allowed_non_write_users:/m,
      '書き込み権限の無い人に開放する設定が入っている');
    assert.doesNotMatch(t, /^\s*allowed_bots:\s*'?\*/m, 'すべてのbotに開放されている');
  });

  test('AIのツールが制限されている', () => {
    for (const f of ['claude-daily.yml', 'claude-mention.yml']) {
      const t = load(f);
      assert.match(t, /--allowedTools/, `${f}: allowedTools の制限が無い`);
      assert.doesNotMatch(t, /--dangerously/, `${f}: 危険なフラグがある`);
      assert.doesNotMatch(t, /bypassPermissions/, `${f}: 権限バイパスがある`);
    }
  });
});
