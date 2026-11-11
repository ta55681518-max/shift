import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const daily=fs.readFileSync(path.join(root,'.github/workflows/claude-daily.yml'),'utf8');
const ci=fs.readFileSync(path.join(root,'.github/workflows/test.yml'),'utf8');
test('事前テストを実行するジョブがNode 24を準備する',()=>{
 const guard=daily.slice(daily.indexOf('  guard:'),daily.indexOf('  develop:'));
 assert.match(guard,/uses: actions\/setup-node@v4\s+with:\s+node-version: '24'/);
 assert.ok(guard.indexOf('actions/setup-node')<guard.indexOf('node --test'));
});
test('結果記録はcheckoutせずリポジトリを明示する',()=>{
 const record=daily.slice(daily.indexOf('  record:'));
 assert.doesNotMatch(record,/actions\/checkout/);
 assert.match(record,/GH_REPO: \$\{\{ github.repository \}\}/);
 assert.doesNotMatch(record,/contents: write/);
});
test('CIの両方の判定が共通の検証処理を使う',()=>{
 assert.equal((ci.match(/node automation\/check-risk\.mjs/g)||[]).length,2);
 assert.doesNotMatch(ci,/set \+e/);
});
const valid=risk=>JSON.stringify({risk,reason:'確認結果',files:['README.md']});
for(const [label,code,json,expected] of [
 ['低リスク',0,valid('low'),0],['要レビュー',1,valid('review'),0],['保護対象',2,valid('blocked'),0],
 ['判定不能',3,valid('blocked'),1],['不正なJSON',1,'不正',1],['空の出力',1,'',1],
 ['不明な区分',0,valid('invalid'),1],['終了コード不一致',0,valid('blocked'),1],
 ['理由欠落',0,'{"risk":"low","files":[]}',1],['ファイル一覧欠落',0,'{"risk":"low","reason":"理由"}',1],
 ])test('リスク判定の検証：'+label,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shift-ci-node-'));
 try {
  const automation=path.join(dir,'automation');fs.mkdirSync(automation);
  fs.copyFileSync(path.join(root,'automation/check-risk.mjs'),path.join(automation,'check-risk.mjs'));
  fs.writeFileSync(path.join(automation,'classify-risk.mjs'),'process.stdout.write(process.env.MOCK_JSON); process.exit(Number(process.env.MOCK_CODE));');
  const output=path.join(dir,'output'),summary=path.join(dir,'summary');
  const result=spawnSync(process.execPath,[path.join(automation,'check-risk.mjs'),'origin/develop'],{encoding:'utf8',env:{...process.env,MOCK_JSON:json,MOCK_CODE:String(code),GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary}});
  assert.ifError(result.error);assert.equal(result.status,expected,result.stderr);
  assert.equal(fs.existsSync(output),expected===0);assert.equal(fs.existsSync(summary),expected===0);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
