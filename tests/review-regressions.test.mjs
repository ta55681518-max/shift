import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {REPO} from './helpers/env.mjs';

test('既存のNetlify FunctionをCommonJSのハンドラーとして取得できる',()=>{
  const source="const f=require(process.argv[1]); if(typeof f.handler!=='function') process.exit(1);";
  const result=spawnSync(process.execPath,['--input-type=commonjs','-e',source,path.join(REPO,'netlify/functions/ai.js')],{encoding:'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
});

test('本番異常の通知先は作業フォルダーに依存しない',()=>{
  const workflow=fs.readFileSync(path.join(REPO,'.github/workflows/smoke-production.yml'),'utf8');
  const notify=workflow.slice(workflow.indexOf('  notify:'));
  assert.match(notify,/GH_REPO:\s*\$\{\{\s*github.repository\s*\}\}/,'checkoutのない通知ジョブで送信先が指定されていない');
});

for(const status of ['401','500','502','503','000','200','404','','401000']) {
  test(`AI窓口の監視：${status || '空の応答'}を正しく扱う`,()=>{
    const result=spawnSync(process.execPath,[path.join(REPO,'automation/check-ai-smoke-status.mjs'),status],{encoding:'utf8'});
    assert.ifError(result.error);
    assert.equal(result.status,status==='401'?0:1,result.stderr);
  });
}
