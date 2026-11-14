/* ============================================================
   串焼KEMURI屋 売上カレンダー用の計算（読むだけ。保存は一切しない）
   ------------------------------------------------------------
   ・国民の祝日（2022年〜）を、祝日法の決まりから求める
       固定の日／ハッピーマンデー／春分・秋分（計算式）／
       振替休日（祝日が日曜 → その後の最初の祝日でない日）／
       国民の休日（祝日にはさまれた平日）
     2026年・2027年は内閣府の一覧と一致することを試験で確かめている。
     春分・秋分は前年2月に正式に決まるので、2年以上先は «見込み»。
   ・沖縄の日（慰霊の日 6/23）は «祝日ではない印» として別に持つ
   ・月のカレンダー（月曜はじまりの週）と、忙しさの色分け
   2020・2021年は東京五輪の特例で祝日が動いたため対象外（2022年より前は空を返す）
   ============================================================ */
(function (global) {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  /* 時差のずれを避けるため、日付は UTC の正午で作る */
  function mk(y, m, d) { return new Date(Date.UTC(y, m - 1, d, 12)); }
  function parse(s) { var p = String(s).split('-'); return mk(+p[0], +p[1], +p[2]); }
  function fmt(dt) { return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
  function addDays(s, n) { var dt = parse(s); dt.setUTCDate(dt.getUTCDate() + n); return fmt(dt); }
  function dow(s) { return parse(s).getUTCDay(); }                 /* 0=日 … 6=土 */
  function nthMonday(y, m, n) {
    var first = mk(y, m, 1).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  }
  function shunbun(y) { return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }
  function shubun(y)  { return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }

  var cache = {};
  /* その年の祝日・休日 { 'YYYY-MM-DD': 名前 } */
  function holidays(y) {
    y = +y;
    if (cache[y]) return cache[y];
    var h = {};
    if (!(y >= 2022 && y <= 2099)) { cache[y] = h; return h; }
    h[ymd(y, 1, 1)] = '元日';
    h[ymd(y, 1, nthMonday(y, 1, 2))] = '成人の日';
    h[ymd(y, 2, 11)] = '建国記念の日';
    h[ymd(y, 2, 23)] = '天皇誕生日';
    h[ymd(y, 3, shunbun(y))] = '春分の日';
    h[ymd(y, 4, 29)] = '昭和の日';
    h[ymd(y, 5, 3)] = '憲法記念日';
    h[ymd(y, 5, 4)] = 'みどりの日';
    h[ymd(y, 5, 5)] = 'こどもの日';
    h[ymd(y, 7, nthMonday(y, 7, 3))] = '海の日';
    h[ymd(y, 8, 11)] = '山の日';
    h[ymd(y, 9, nthMonday(y, 9, 3))] = '敬老の日';
    h[ymd(y, 9, shubun(y))] = '秋分の日';
    h[ymd(y, 10, nthMonday(y, 10, 2))] = 'スポーツの日';
    h[ymd(y, 11, 3)] = '文化の日';
    h[ymd(y, 11, 23)] = '勤労感謝の日';
    var base = Object.keys(h).sort();
    /* 振替休日：祝日が日曜なら、そのあとの最初の «祝日でない日» */
    base.forEach(function (d) {
      if (dow(d) !== 0) return;
      var n = addDays(d, 1);
      while (h[n]) n = addDays(n, 1);
      h[n] = '振替休日';
    });
    /* 国民の休日：前の日と次の日が祝日の、祝日でない日（日曜は除く） */
    base.forEach(function (d) {
      var mid = addDays(d, 1), nx = addDays(d, 2);
      if (!h[mid] && base.indexOf(nx) >= 0 && dow(mid) !== 0) h[mid] = '国民の休日';
    });
    cache[y] = h;
    return h;
  }
  function holidayOf(d) { return holidays(+String(d).slice(0, 4))[d] || ''; }
  /* 祝日ではないが、印を付けておく沖縄の日 */
  function localOf(d) { return String(d).slice(5) === '06-23' ? '慰霊の日' : ''; }
  /* 春分・秋分が «見込み» の年か（正式な発表は前年2月） */
  function tentative(y, nowYear) { return +y > (+nowYear || new Date().getFullYear()) + 1; }

  /* 天気の文字 → 絵文字（POSの書き方がまちまちなので、含まれる文字で決める） */
  function weatherIcon(w) {
    w = String(w || '');
    if (!w) return '';
    if (/台風|暴風/.test(w)) return '🌀';
    if (/雪/.test(w)) return '⛄';
    if (/雷/.test(w)) return '⚡';
    if (/雨/.test(w)) return '☔';
    if (/曇|くもり/.test(w)) return '☁️';
    if (/晴/.test(w)) return '☀️';
    return '';
  }

  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  /* ものさし：その年の営業日の1日あたり売上。日数が少ない年は、入っている全部で */
  function yardstick(days, year) {
    var sy = 0, ny = 0, sa = 0, na = 0;
    Object.keys(days || {}).forEach(function (d) {
      var g = num(days[d] && days[d].gross);
      if (!(g > 0)) return;
      sa += g; na++;
      if (d.slice(0, 4) === String(year)) { sy += g; ny++; }
    });
    if (ny >= 14) return { avg: sy / ny, days: ny, scope: 'year' };
    if (na > 0) return { avg: sa / na, days: na, scope: 'all' };
    return { avg: 0, days: 0, scope: 'none' };
  }
  function levelOf(g, avg) {
    if (!(g > 0)) return 'off';
    if (!(avg > 0)) return 'l2';
    var r = g / avg;
    return r >= 1.5 ? 'l4' : r >= 1.2 ? 'l3' : r >= 0.9 ? 'l2' : 'l1';
  }

  /* 1か月ぶんのカレンダー。days は KemuriData.daily の days（読むだけ） */
  function month(ym, days) {
    days = days || {};
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var last = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
    var ys = yardstick(days, y);
    var first = ymd(y, m, 1);
    var start = addDays(first, -((dow(first) + 6) % 7));   /* その週の月曜 */
    var weeks = [], cur = start, lastDay = ymd(y, m, last);
    var sum = 0, open = 0, closed = 0, guests = 0, has = 0, best = null;
    while (cur <= lastDay) {
      var w = { cells: [], total: 0, open: 0, closed: 0, avg: 0, index: null, label: '', cls: 'non', from: '', to: '' };
      for (var i = 0; i < 7; i++) {
        var d = addDays(cur, i), inM = d.slice(0, 7) === ym, r = days[d];
        var c = { date: d, day: +d.slice(8, 10), dow: dow(d), inMonth: inM, hasData: !!r && inM,
                  gross: 0, guests: 0, groups: 0, weather: '', holiday: '', local: '', level: 'none' };
        if (inM) {
          c.holiday = holidayOf(d); c.local = localOf(d);
          if (!w.from) w.from = d; w.to = d;
          if (r) {
            c.gross = num(r.gross); c.guests = num(r.guests); c.groups = num(r.groups); c.weather = r.weather || '';
            c.level = levelOf(c.gross, ys.avg); has++;
            if (c.gross > 0) {
              w.total += c.gross; w.open++; sum += c.gross; open++; guests += c.guests;
              if (!best || c.gross > best.gross) best = c;
            } else { w.closed++; closed++; }
          }
        }
        w.cells.push(c);
      }
      if (w.open) {
        w.avg = Math.round(w.total / w.open);
        if (ys.avg > 0) {
          w.index = Math.round(w.avg / ys.avg * 100) / 100;
          if (w.open <= 2) { w.label = '営業' + w.open + '日だけ'; w.cls = 'non'; }
          else if (w.index >= 1.3) { w.label = 'とても忙しい'; w.cls = 'hi'; }
          else if (w.index >= 1.1) { w.label = '忙しい'; w.cls = 'hi'; }
          else if (w.index >= 0.9) { w.label = 'ふつう'; w.cls = 'mid'; }
          else { w.label = 'ひま'; w.cls = 'lo'; }
        }
      }
      weeks.push(w);
      cur = addDays(cur, 7);
    }
    return { ym: ym, year: y, month: m, weeks: weeks, daysInMonth: last, hasData: has, missing: Math.max(0, last - has),
             sum: sum, open: open, closed: closed, guests: guests, avg: open ? Math.round(sum / open) : 0,
             best: best, yard: ys };
  }

  /* 別の年の «同じ曜日の並び» の日（52週 × 年数ぶんずらす。曜日は必ず同じになる） */
  function sameWeekday(d, targetYear) {
    var diff = +targetYear - +String(d).slice(0, 4);
    return addDays(d, diff * 364);
  }

  global.KemuriCal = {
    holidays: holidays, holidayOf: holidayOf, localOf: localOf, tentative: tentative,
    weatherIcon: weatherIcon, month: month, sameWeekday: sameWeekday, yardstick: yardstick,
    addDays: addDays, dow: dow,
  };
})(typeof window !== 'undefined' ? window : globalThis);
