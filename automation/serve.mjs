#!/usr/bin/env node
/* ============================================================
   ローカル配信サーバ（依存ゼロ）
   ------------------------------------------------------------
     node automation/serve.mjs          → http://localhost:8080
     node automation/serve.mjs 3000     → ポート指定

   ・ブラウザで実機確認するときに使う
   ・localStorage は «ブラウザ × URL» ごとに別なので、
     localhost で開いたデータは本番（netlify.app）とは完全に別物。
     → ここで何をしても本番データには触らない
   ・GET / HEAD だけ。書き込み系のメソッドは受け付けない
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gs': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('GET / HEAD のみ対応しています');
    return;
  }

  let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (rel === '/') rel = '/index.html';

  /* リポジトリの外に出ないようにする */
  const abs = path.resolve(REPO, '.' + rel);
  if (!abs.startsWith(REPO + path.sep) && abs !== REPO) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (/[\\/](node_modules|\.git|\.github)[\\/]/.test(abs)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + rel);
    return;
  }

  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    /* 本番の netlify.toml と同じく、古い画面が残らないようにする */
    'Cache-Control': 'public, max-age=0, must-revalidate',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`配信中: http://localhost:${PORT}/`);
  console.log('  ホーム（売上・原価）  http://localhost:' + PORT + '/dashboard.html');
  console.log('  冷凍在庫・POS取込    http://localhost:' + PORT + '/reitou.html');
  console.log('  串焼き在庫          http://localhost:' + PORT + '/kushiyaki.html');
  console.log('  発注               http://localhost:' + PORT + '/hacchu.html');
  console.log('');
  console.log('※ localStorage は URL ごとに別です。ここのデータは本番とは無関係です。');
  console.log('止めるには Ctrl+C');
});
