#!/usr/bin/env node
/* ============================================================
   変更ファイル → リスク区分
   ------------------------------------------------------------
   使い方:
     node automation/classify-risk.mjs <base-ref>        # git diff から判定
     node automation/classify-risk.mjs --files a.js b.js # 明示指定
     node automation/classify-risk.mjs --json            # JSON で出力

   終了コード:
     0 … low（自動マージ候補）
     1 … review（人が見る）
     2 … blocked（自動マージ禁止）
     3 … 判定できなかった（安全側で blocked 扱い）

   GitHub Actions からは $GITHUB_OUTPUT に risk / reason を書き出す。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'automation', 'risk-policy.json'), 'utf8'));

/* ---- glob を正規表現に落とす（簡易版）
       "**" + "/" … ディレクトリを跨ぐ / "**" … 残り全部 / "*" … 1階層内のみ ---- */
const RE_SPECIAL = '.+^${}()|[]\\?';
function toRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (RE_SPECIAL.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

const compiled = {
  blocked: policy.blocked.patterns.map(toRegExp),
  review: policy.review.patterns.map(toRegExp),
  low: policy.low.patterns.map(toRegExp),
};
function match(list, file) { return list.some(re => re.test(file)); }

/* ---- 変更ファイルの取得 ---- */
function changedFiles(args) {
  const i = args.indexOf('--files');
  if (i >= 0) return args.slice(i + 1).filter(a => !a.startsWith('--'));

  const base = args.find(a => !a.startsWith('--')) || process.env.BASE_REF || 'origin/develop';
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(base)) return null;
  try {
    const out = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`, '--'], { cwd: REPO, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;   // 判定できない
  }
}

/* ---- 変更量 ---- */
function diffStat(base) {
  try {
    const out = execFileSync('git', ['diff', '--no-renames', '--numstat', `${base}...HEAD`, '--'], { cwd: REPO, encoding: 'utf8' });
    let added = 0, deleted = 0;
    for (const line of out.split('\n')) {
      const [a, d] = line.split('\t');
      if (a === '-' || d === '-') continue;          // バイナリ
      added += Number(a) || 0;
      deleted += Number(d) || 0;
    }
    return { added, deleted };
  } catch {
    return null;
  }
}

/* ---- 本体 ---- */
const args = process.argv.slice(2);
const files = changedFiles(args);
const asJson = args.includes('--json');
const detail = { blocked: [], review: [], low: [], unknown: [] };

function finish(risk, reason, code) {
  const result = { risk, reason, files: files ?? [], detail };
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`risk=${risk}`);
    console.log(`reason=${reason}`);
    console.log(`files=${files ? files.length : 0}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `risk=${risk}\nreason=${reason.replace(/[\r\n]/g, ' ')}\nfile_count=${files ? files.length : 0}\n`);
  }
  process.exit(code);
}

if (files === null) {
  finish('blocked', '変更ファイルを取得できなかったため、安全側で blocked にしました', 3);
}
if (files.length === 0) {
  finish('low', '変更ファイルがありません', 0);
}

for (const f of files) {
  if (match(compiled.blocked, f)) detail.blocked.push(f);
  else if (match(compiled.review, f)) detail.review.push(f);
  else if (match(compiled.low, f)) detail.low.push(f);
  else detail.unknown.push(f);
}

const lim = policy.limits;
const base = args.find(a => !a.startsWith('--')) || process.env.BASE_REF || 'origin/develop';
const stat = args.includes('--files') ? null : diffStat(base);

if (!args.includes('--files') && !stat) {
  finish('blocked', '変更量を取得できないため判定を停止しました', 3);
}
if (detail.blocked.length) {
  finish('blocked', `自動マージ禁止のファイルが含まれています: ${detail.blocked.join(', ')}`, 2);
} else if (detail.unknown.length) {
  finish('blocked', `ポリシーに無いファイルがあります（安全側で禁止）: ${detail.unknown.join(', ')}`, 2);
} else if (files.length > lim.maxChangedFiles) {
  finish('review', `変更ファイル数が上限を超えています（${files.length} > ${lim.maxChangedFiles}）`, 1);
} else if (stat && stat.added > lim.maxAddedLines) {
  finish('review', `追加行数が上限を超えています（${stat.added} > ${lim.maxAddedLines}）`, 1);
} else if (stat && stat.deleted > lim.maxDeletedLines) {
  finish('review', `削除行数が上限を超えています（${stat.deleted} > ${lim.maxDeletedLines}）`, 1);
} else if (detail.review.length) {
  finish('review', `人のレビューが必要なファイル: ${detail.review.join(', ')}`, 1);
} else {
  finish('low', `低リスクの変更のみ（${detail.low.length}件）`, 0);
}
