/* ============================================================
   音声メモ（/memo/）専用の Service Worker
   ・役目は «通知を出す» と «通知を押したらメモを開く» だけ。
   ・fetch は横取りしない（キャッシュもしない）。
   ・scope は /memo/ フォルダ。
   ============================================================ */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

/* Xserver（memo-api の cron）から届くリマインド。アプリを閉じていても鳴る */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '🔔 音声メモ', {
    body: d.body || '',
    icon: 'memo-icon.png',
    badge: 'memo-icon.png',
    tag: 'memo-' + (d.id || Date.now()),
    data: { id: d.id || '' },
    vibrate: [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var id = (e.notification.data && e.notification.data.id) || '';
  var url = self.registration.scope + (id ? '#memo=' + encodeURIComponent(id) : '');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
          c.postMessage({ type: 'open-memo', id: id });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
