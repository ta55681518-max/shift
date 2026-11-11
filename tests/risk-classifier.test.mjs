import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers/env.mjs';
function classify(args) { return spawnSync(process.execPath,['automation/classify-risk.mjs',...args,'--json'],{cwd:REPO,encoding:'utf8'}); }
test('権限と判定器の変更は低リスクにしない',()=>{
 for(const file of ['automation/classify-risk.mjs','.claude/settings.json','AGENTS.md','CLAUDE.md']) {
  const r=classify(['--files',file]); assert.equal(r.status,2); assert.equal(JSON.parse(r.stdout).risk,'blocked');
 }
});
test('未登録ファイルは安全側で保護する',()=>{const r=classify(['--files','unknown.new']);assert.equal(r.status,2);});
test('低リスクと人のレビュー対象を区別する',()=>{
 assert.equal(classify(['--files','README.md']).status,0);
 assert.equal(classify(['--files','dashboard.html']).status,1);
});
test('シェル構文を含む比較元を実行しない',()=>{
 const r=classify(['main; echo INJECTED']); assert.equal(r.status,3); assert.doesNotMatch(r.stdout,/INJECTED/);
});
test('比較元が存在しなければ判定を失敗させる',()=>{assert.equal(classify(['refs/heads/does-not-exist-12345']).status,3);});
