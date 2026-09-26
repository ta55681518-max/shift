/* ============================================================
   串焼KEMURI屋  古いURL用のお知らせ  site-notice.js
   ------------------------------------------------------------
   アプリは GitHub Pages（ta55681518-max.github.io）から
   Netlify（comfy-khapse-8a3cae.netlify.app）へ引っ越した。
   ファイルは同じものが両方から配られるので、見た目では
   どちらを開いているか分からない。実際、古いほうを開いて
   「取り込んだはずのデータが無い」「取消が効かない」が起きた。

   データは «ブラウザ × URL» ごとに別なので、URLが違えば中身も別。
   そこで、古いURLで開いたときだけ上に帯を出して知らせる。
   ふだんは自動では飛ばさない。引っ越しのバックアップ書き出しに
   古いほうを開く必要があるため。

   ただし «#pos=…» つきで開かれたときだけは例外で、その場のまま
   新しいURLへ送る。これはPOSの取り込みボタンから来たときの形で、
   　・中身は売上データだけ。バックアップ書き出しとは関係がない
   　・古いほうで取り込んでしまうと、古いほうの在庫が動く
   　・reitou.html は起動時に読み取ったあとURLからこれを消すので、
   　　帯を出してから押してもらう形では中身が引き継げない
   という理由から、読み取られる前に送ってしまうのが唯一の手になる。
   → そのため、このファイルはアプリ本体より先に読み込む（<head>）。
   ============================================================ */
(function () {
  'use strict';
  var NEW_HOST = 'comfy-khapse-8a3cae.netlify.app';
  var host = (location.hostname || '').toLowerCase();
  if (host.indexOf('github.io') < 0) return;      // 新しいURL・手元の確認用では出さない

  var page = (location.pathname.split('/').pop() || 'index.html');
  function newUrl(hash) {
    return 'https://' + NEW_HOST + '/' + page + location.search + (hash || '');
  }

  /* POSの取り込みボタンから来た（#pos=…）ときは、読み取られる前に送る */
  var hash = location.hash || '';
  if (/[#&]pos=/.test(hash)) {
    /* 飛ぶ前に本体が読み取ってしまわないよう印をつける。
       location.replace のあとも、実際に移るまでページの読み込みは続くため。 */
    window.__kemuriMoving = 1;
    location.replace(newUrl(hash));
    return;
  }

  function show() {
    if (document.getElementById('kemuri-old-site')) return;

    var bar = document.createElement('div');
    bar.id = 'kemuri-old-site';
    bar.setAttribute('style', [
      'position:sticky', 'top:0', 'z-index:99999',
      'background:#b3261e', 'color:#fff',
      'padding:calc(12px + env(safe-area-inset-top)) 14px 12px',
      'font-size:15px', 'line-height:1.6', 'font-weight:700',
      'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)'
    ].join(';'));
    bar.innerHTML =
      '⚠️ これは<u>古いほう</u>のアプリです<br>'
      + '<span style="font-weight:400;font-size:13px">'
      + 'ここで取り込んでも、新しいほうには入りません。</span>'
      + '<a href="' + newUrl(location.hash) + '" style="display:block;margin-top:10px;background:#fff;color:#b3261e;'
      + 'text-align:center;text-decoration:none;border-radius:12px;padding:13px;font-size:16px;'
      + 'font-weight:700">新しいほうを開く →</a>';

    var b = document.body;
    if (b) b.insertBefore(bar, b.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
