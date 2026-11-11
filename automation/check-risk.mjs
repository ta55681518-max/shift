// 判定器の終了コードと出力を検証し、判定不能ならCIを停止する。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const base=process.argv[2];
const env={...process.env};
delete env.GITHUB_OUTPUT;
const args=[path.join(import.meta.dirname,'classify-risk.mjs')];
if(base)args.push(base);
args.push('--json');
const child=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
try {
  if(child.error || ![0,1,2].includes(child.status)) throw new Error('リスク判定を実行できませんでした');
  const result=JSON.parse(child.stdout);
  if(result?.risk!==['low','review','blocked'][child.status] || typeof result.reason!=='string' || !Array.isArray(result.files)) {
    throw new Error('リスク判定の出力が不正です');
  }
  const reason=result.reason.replace(/[\r\n]/g,' ');
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`risk=${result.risk}\nreason=${reason}\nfile_count=${result.files.length}\n`);
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`リスク区分: ${result.risk}\n${reason}\nすべての変更に人のPR承認が必要です。\n`);
  console.log(JSON.stringify(result,null,2));
} catch {
  console.error('リスク判定を検証できないため、処理を停止しました');
  process.exitCode=1;
}
