/* ============================================================
   串焼KEMURI屋  テスト環境専用  test-env.js
   ------------------------------------------------------------
   ※ このファイルは test-env ブランチ（テストサイト）にだけある。
     main（本番）には入れない。

   やること
   ・全画面の上に赤い帯「テスト環境・本番ではありません」を出す
   ・このサイトの外への通信（fetch / XMLHttpRequest / sendBeacon）を止める
     → シフト提出・予約送信・串在庫の共有（Google Apps Script）や、
       本番サイトへの送信が、テストから本番に届かないようにする
   ・本番サイトへのリンクを開かせない
   ・本番のホスト名で読み込まれた場合は何もしない（念のため）
   ============================================================ */
(function () {
  'use strict';
  var PROD_HOST = 'comfy-khapse-8a3cae.netlify.app';
  var host = (location.hostname || '').toLowerCase();
  if (host === PROD_HOST) return;

  window.KEMURI_ENV = 'test';
  var blocked = [];

  function sameOrigin(url) {
    try { return new URL(String(url), location.href).origin === location.origin; }
    catch (e) { return false; }
  }
  function note(kind, url) {
    blocked.push(kind + ' ' + String(url).slice(0, 120));
    try { console.warn('[テスト環境] 外部への通信を止めました:', kind, url); } catch (e) {}
    var b = document.getElementById('kemuri-test-blocked');
    if (b) { b.textContent = '外部への送信を止めました（' + blocked.length + '件）'; b.style.display = 'block'; }
  }
  window.__kemuriTestBlocked = blocked;

  /* --- fetch --- */
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
      if (!sameOrigin(url)) {
        note('fetch', url);
        return Promise.reject(new TypeError('テスト環境では外部への通信はできません'));
      }
      return origFetch(input, init);
    };
  }
  /* --- XMLHttpRequest --- */
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (!sameOrigin(url)) {
        note('xhr', url);
        throw new TypeError('テスト環境では外部への通信はできません');
      }
      return origOpen.apply(this, arguments);
    };
  }
  /* --- sendBeacon --- */
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (!sameOrigin(url)) { note('beacon', url); return false; }
      return origBeacon(url, data);
    };
  }
  /* --- 本番サイトへのリンク --- */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var h = '';
    try { h = new URL(a.getAttribute('href'), location.href).hostname.toLowerCase(); } catch (e) { return; }
    if (h === PROD_HOST) {
      ev.preventDefault();
      note('link', a.getAttribute('href'));
      alert('テスト環境から本番サイトは開けません。');
    }
  }, true);

  /* --- 赤い帯 --- */
  function band() {
    if (document.getElementById('kemuri-test-band')) return;
    var bar = document.createElement('div');
    bar.id = 'kemuri-test-band';
    bar.setAttribute('role', 'alert');
    bar.setAttribute('style', [
      'position:sticky', 'top:0', 'z-index:100000',
      'background:#b3261e', 'color:#fff', 'text-align:center',
      'padding:calc(8px + env(safe-area-inset-top)) 12px 8px',
      'font-size:15px', 'line-height:1.5', 'font-weight:700',
      'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif'
    ].join(';'));
    bar.innerHTML = 'テスト環境・本番ではありません'
      + '<span id="kemuri-test-blocked" style="display:none;font-weight:400;font-size:12px"></span>';
    document.body.insertBefore(bar, document.body.firstChild);
    if (blocked.length) { var b = document.getElementById('kemuri-test-blocked'); b.textContent = '外部への送信を止めました（' + blocked.length + '件）'; b.style.display = 'block'; }
  }
  if (document.body) band();
  else document.addEventListener('DOMContentLoaded', band);
})();
