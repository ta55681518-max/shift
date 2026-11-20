/* ============================================================
   音声メモ（memo.html）専用の Service Worker
   ・役目は «通知を出す» と «通知を押したらメモを開く» だけ。
   ・fetch は横取りしない（キャッシュもしない）ので、
     ほかのアプリ（在庫・発注など）の動きには一切関係しない。
   ・scope は memo.html だけに絞って登録している。
   ============================================================ */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var id = (e.notification.data && e.notification.data.id) || '';
  var url = 'memo.html' + (id ? '#memo=' + encodeURIComponent(id) : '');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf('memo.html') >= 0 && 'focus' in c) {
          c.postMessage({ type: 'open-memo', id: id });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
