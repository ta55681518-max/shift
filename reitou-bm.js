/* ============================================================
   串焼KEMURI屋 冷凍在庫アプリ用 取り込みボタン（読み込まれる本体）

   エクストリンクPOSの「商品別商品集計」を抽出したページで実行すると、
   　・抽出期間（画面の日付欄）
   　・商品名 ＋ 出数
   を読み取って、冷凍在庫アプリ（reitou.html）をその内容つきで開く。
   → 開いた時点でプレビューが出るので「在庫に反映する」を押すだけ。
   （念のためクリップボードにも同じ内容をコピーする）

   コピーされる中身の例：
     串焼KEMURI屋 冷凍在庫
     抽出期間<TAB>2026-09-01～2026-09-15
     商品名<TAB>出数
     ポテトフライ<TAB>36
     茶豆<TAB>22

   ※ zaikoの取り込みボタン（bookmarklet-source.js）と同じ読み取り方。
     E-POSの表は「商品名」が左に固定された別テーブル、数字（平均単価/出数/
     金額…）が別テーブルという構成なので、固定列と数字列を行ごとに合体して読む。
     値段(円)・比率(%)・小数は除外し、出数（裸の整数）だけを拾う。

   ※ このファイルは GitHub Pages から読み込まれる本体。
     ブックマークには短いローダーだけを入れておけば、
     直すときはこのファイルを更新するだけで貼り替え不要。
   ============================================================ */
(function () {
  try {
    var norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
    var toNum = function (s) { return (s || '').replace(/[,\s]/g, ''); };

    /* 「円」「%」「小数」を含まない裸の整数 = 出数とみなす（平均単価・金額・粗利・比率を除外） */
    var isBareInt = function (s) {
      var t = norm(s);
      return !/[円%¥￥.]/.test(t) && /^\d{1,6}$/.test(toNum(t));
    };
    /* 商品名らしいセル：文字を含む。ABC欄・見出し語・合計行は除外 */
    var isName = function (s) {
      var t = norm(s);
      if (!t) return false;
      if (/^[A-EＡ-Ｅ]$/.test(t)) return false;
      if (/合計|総計|小計|商品名|メニュー|品名|出数|数量|平均|単価|金額|粗利|構成|比率|カテゴリ|部門|順位/.test(t)) return false;
      return /[^\d,.\s円%¥￥\-]/.test(t);
    };

    /* 表は本体ページだけでなく iframe の中にあることもある */
    var docs = [document];
    [].slice.call(document.querySelectorAll('iframe,frame')).forEach(function (f) {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
    });

    /* ---- 抽出期間を拾う（日付の入力欄 → 無ければ画面の文字から） ---- */
    var pad = function (s) {
      var m = String(s).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
      return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
    };
    var dates = [];
    docs.forEach(function (d) {
      [].slice.call(d.querySelectorAll('input')).forEach(function (i) {
        var v = norm(i.value);
        if (/^\d{4}\D\d{1,2}\D\d{1,2}$/.test(v)) { var p = pad(v); if (p) dates.push(p); }
      });
    });
    if (dates.length < 2) {
      var txt = '';
      docs.forEach(function (d) { try { txt += ' ' + (d.body ? d.body.innerText : ''); } catch (e) {} });
      var m2 = txt.match(/(\d{4}\D\d{1,2}\D\d{1,2})\s*[～~〜]\s*(\d{4}\D\d{1,2}\D\d{1,2})/);
      if (m2) dates = [pad(m2[1]), pad(m2[2])];
    }

    /* ---- 表から 商品名 と 出数 を拾う ---- */
    var tables = [];
    docs.forEach(function (d) { tables = tables.concat([].slice.call(d.querySelectorAll('table'))); });

    function cellsOf(r) {
      return [].slice.call(r.querySelectorAll('td,th')).map(function (c) { return norm(c.textContent); });
    }
    var nameCols = [], qtyCols = [];
    tables.forEach(function (t) {
      var rows = [].slice.call(t.querySelectorAll('tr')), names = [], qtys = [];
      rows.forEach(function (r) {
        var c = cellsOf(r), nm = '', q = '';
        for (var i = 0; i < c.length; i++) { if (isName(c[i])) { nm = c[i]; break; } }
        for (var j = 0; j < c.length; j++) { if (isBareInt(c[j])) { q = toNum(c[j]); break; } }
        names.push(nm); qtys.push(q);
      });
      nameCols.push(names); qtyCols.push(qtys);
    });
    function cnt(a) { var n = 0; a.forEach(function (x) { if (x) n++; }); return n; }
    var nameT = -1, nb = 0; nameCols.forEach(function (a, i) { var c = cnt(a); if (c > nb) { nb = c; nameT = i; } });
    var qtyT = -1, qb = 0; qtyCols.forEach(function (a, i) { var c = cnt(a); if (c > qb) { qb = c; qtyT = i; } });

    var out = [];
    if (nameT >= 0 && qtyT >= 0) {
      var N = nameCols[nameT], Q = qtyCols[qtyT], L = Math.max(N.length, Q.length);
      for (var k = 0; k < L; k++) { if (N[k] && Q[k]) out.push(N[k] + '\t' + Q[k]); }
    }
    if (!out.length) {
      alert('データが読み取れませんでした。\n「商品別商品集計」を抽出した表のページで押してください。');
      return;
    }

    /* ---- 冷凍在庫アプリが読める形に組み立てる ---- */
    var head = ['串焼KEMURI屋 冷凍在庫'];
    if (dates.length >= 2) head.push('抽出期間\t' + dates[0] + '～' + dates[1]);
    head.push('商品名\t出数');
    var text = head.concat(out).join('\n');

    /* 冷凍在庫アプリを、読み取った売上を持たせて開く。
       貼り付けの操作が要らず、開いた時点でプレビューが出る。
       （うまく開けなかったときのために、クリップボードにもコピーしておく） */
    var APP = 'https://ta55681518-max.github.io/shift/reitou.html';
    var openApp = function () {
      try { location.href = APP + '#pos=' + encodeURIComponent(text); }
      catch (e) {
        window.prompt('下の内容をコピーして冷凍在庫アプリに貼ってください', text);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(openApp, openApp);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
      openApp();
    }
  } catch (e) {
    alert('エラーが出ました: ' + (e && e.message ? e.message : e));
  }
})();
