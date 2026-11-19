/* ============================================================
   串焼KEMURI屋  古いURL用のお知らせ  site-notice.js
   ------------------------------------------------------------
   引っ越しの歴史
   　① GitHub Pages（ta55681518-max.github.io）→ Netlify（comfy-khapse-8a3cae.netlify.app）
   　② 2026-11-19：冷凍在庫・売上原価 を Netlify → Xserver（kanri.kemuriya-shuri.com）
   　　串焼き在庫（休止中）も、再開するときは Xserver 側を使う。
   　　シフト希望・オードブルご予約・発注は、まだ Netlify で使っている。

   データは «ブラウザ × URL» ごとに別なので、URLが違えば中身も別。
   古いURLで入力すると、新しいほうには入らない。

   ■ 引っ越したページ（MOVED）を古いURL（Netlify・GitHub Pages）で開いたとき
   　・«#pos=…» つき（POSの取り込みボタンから来た）なら、読み取られる前に
   　　新しいURLへそのまま送る。古いほうの在庫を動かさないため。
   　　→ そのため、このファイルはアプリ本体より先に読み込む（<head>）。
   　・それ以外は、画面全体を「引っ越しました」の案内で覆って、入力できなくする。
   　　データは消さない。念のため «控えを書き出す» ボタンだけ残す
   　　（古いアイコンに入力してしまったときに、あとで取り出せるように）。

   ■ まだ引っ越していないページを GitHub Pages で開いたとき
   　今までどおり、上に赤い帯を出して Netlify へ案内する（自動では飛ばさない）。

   ■ Netlify で、まだ引っ越していないページ → 何もしない。
   ============================================================ */
(function () {
  'use strict';
  var NETLIFY_HOST = 'comfy-khapse-8a3cae.netlify.app';
  var XSERVER_HOST = 'kanri.kemuriya-shuri.com';
  /* 串焼き在庫は 2026-11 時点で休止中。データは移していないが、再開するときは
     新しいほう（新しい冷凍在庫の売上を見て減る）を使うので、古いほうは止める。 */
  var MOVED = { 'reitou.html': 1, 'dashboard.html': 1, 'kushiyaki.html': 1 };

  var host = (location.hostname || '').toLowerCase();
  var onGithub = host.indexOf('github.io') >= 0;
  var onNetlify = host === NETLIFY_HOST || host.slice(-(NETLIFY_HOST.length + 2)) === '--' + NETLIFY_HOST;
  if (!onGithub && !onNetlify) return;      // 新しいURL・テスト・手元の確認用では出さない

  var page = (location.pathname.split('/').pop() || 'index.html');
  var moved = !!MOVED[page];
  if (!moved && !onGithub) return;          // Netlify の、まだ使っているページ

  var NEW_HOST = moved ? XSERVER_HOST : NETLIFY_HOST;
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

  var FONT = 'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif';

  /* ---- まだ引っ越していないページ（GitHub Pages）：今までどおりの赤い帯 ---- */
  function showBar() {
    if (document.getElementById('kemuri-old-site')) return;
    var bar = document.createElement('div');
    bar.id = 'kemuri-old-site';
    bar.setAttribute('style', [
      'position:sticky', 'top:0', 'z-index:99999',
      'background:#b3261e', 'color:#fff',
      'padding:calc(12px + env(safe-area-inset-top)) 14px 12px',
      'font-size:15px', 'line-height:1.6', 'font-weight:700', FONT,
      'box-shadow:0 2px 8px rgba(0,0,0,.2)'
    ].join(';'));
    bar.innerHTML =
      '⚠️ これは<u>古いほう</u>のアプリです<br>'
      + '<span style="font-weight:400;font-size:13px">'
      + 'ここで入力しても、新しいほうには入りません。</span>'
      + '<a href="' + newUrl(location.hash) + '" style="display:block;margin-top:10px;background:#fff;color:#b3261e;'
      + 'text-align:center;text-decoration:none;border-radius:12px;padding:13px;font-size:16px;'
      + 'font-weight:700">新しいほうを開く →</a>';
    var b = document.body;
    if (b) b.insertBefore(bar, b.firstChild);
  }

  /* ---- 引っ越したページ：画面全体を覆って入力できなくする ---- */
  function saveBackup(btn, msg) {
    var B = window.KemuriBackup;
    if (!B) {
      msg.textContent = 'このページでは書き出せません。古いほうの「冷凍在庫」のページを開いて、'
        + '同じボタンを押してください（串焼きのデータも一緒に入ります）。';
      return;
    }
    var name = B.filename().replace(/^kemuri-backup-/, 'kemuri-backup-OLD-');
    var text = B.text();
    var blob = new Blob([text], { type: 'application/json' });
    var done = function () { msg.textContent = '書き出しました（' + name + '）。消さずに取っておいてください。'; };
    try {
      var file = (typeof File === 'function') ? new File([blob], name, { type: 'application/json' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name }).then(done, function (e) {
          if (e && e.name === 'AbortError') return;
          msg.textContent = '書き出せませんでした。';
        });
        return;
      }
    } catch (e) { /* 下の方法で続ける */ }
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      done();
    } catch (e) { msg.textContent = '書き出せませんでした。'; }
  }

  function showCover() {
    if (document.getElementById('kemuri-moved')) return;
    var cover = document.createElement('div');
    cover.id = 'kemuri-moved';
    cover.setAttribute('role', 'dialog');
    cover.setAttribute('aria-modal', 'true');
    cover.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:#fff8f0', 'color:#3a2a1e', 'overflow:auto',
      'padding:calc(28px + env(safe-area-inset-top)) 20px calc(28px + env(safe-area-inset-bottom))',
      'box-sizing:border-box', 'line-height:1.7', FONT
    ].join(';'));
    var link = newUrl('');
    cover.innerHTML =
      '<div style="max-width:440px;margin:0 auto">'
      + '<div style="font-size:44px;text-align:center">🚚</div>'
      + '<h1 style="font-size:22px;margin:6px 0 14px;text-align:center;color:#b3261e">このアプリは引っ越しました</h1>'
      + '<p style="font-size:15px;margin:0 0 10px">ここは<b>古いほう</b>です。ここでは入力できません。</p>'
      + '<p style="font-size:15px;margin:0 0 18px">これからは <b>新しいほう</b>（' + XSERVER_HOST + '）を使ってください。'
      + 'ホーム画面のアイコンも、新しいほうのアイコンを使ってください。</p>'
      + '<a href="' + link + '" style="display:block;background:#b3261e;color:#fff;text-align:center;'
      + 'text-decoration:none;border-radius:14px;padding:16px;font-size:17px;font-weight:700">新しいほうを開く →</a>'
      + '<div style="margin-top:34px;padding-top:16px;border-top:1px solid #e3d3c3;font-size:13px;color:#7a6656">'
      + '<p style="margin:0 0 8px">引っ越しのあとに、まちがえてここに入力してしまったときだけ、'
      + '下のボタンで控えを書き出して、店長に渡してください。ここのデータは消えません。</p>'
      + '<button type="button" id="kemuri-moved-backup" style="width:100%;padding:12px;border-radius:12px;'
      + 'border:1px solid #b9a594;background:#fff;color:#5a4636;font-size:14px">控えを書き出す</button>'
      + '<p id="kemuri-moved-msg" style="margin:8px 0 0;min-height:1.5em"></p>'
      + '</div></div>';
    document.body.appendChild(cover);
    document.documentElement.style.overflow = 'hidden';
    document.getElementById('kemuri-moved-backup').addEventListener('click', function () {
      saveBackup(this, document.getElementById('kemuri-moved-msg'));
    });
    /* 本体のキー操作（入力欄への打ち込みなど）も届かないようにする */
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    document.addEventListener('focusin', function (e) {
      if (!cover.contains(e.target) && e.target && e.target.blur) e.target.blur();
    }, true);
  }

  var show = moved ? showCover : showBar;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})();
