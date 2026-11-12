// 認証なしの確認では401だけが正常。障害・未設定・認証漏れは通知対象にする。
const status=process.argv[2];
if(status==='401') {
  console.log('合言葉なしのアクセスが拒否されています');
} else {
  console.error(`AI窓口の認証拒否を確認できませんでした。HTTP ${JSON.stringify(status ?? '').slice(0,30)}`);
  process.exitCode=1;
}
