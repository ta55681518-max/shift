/**
 * 串焼KEMURI屋 オードブルWeb予約 — GASバックエンド
 *
 * 【セットアップ手順】
 * 1. Googleスプレッドシートを新規作成（名前は自由。例「KEMURI屋オードブル予約」）
 * 2. メニュー → 拡張機能 → Apps Script を開き、このファイルの中身を貼り付けて保存
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      - 次のユーザーとして実行：自分
 *      - アクセスできるユーザー：全員
 * 4. 出てきた「ウェブアプリのURL」を order.html の GAS_URL に貼る
 *
 * シートは初回アクセス時に自動で作られます：
 *   「メニュー」… 商品名 / 説明 / 価格 / 表示（TRUEの行だけお客さまに出ます）
 *   「設定」  … リード日数・受取時間・通知メールなど
 *   「注文」  … 予約が1件1行で貯まります
 */

const SHEET_MENU  = "メニュー";
const SHEET_CONF  = "設定";
const SHEET_ORDER = "注文";

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheets_() {
  const ss = ss_();
  if (!ss.getSheetByName(SHEET_MENU)) {
    const sh = ss.insertSheet(SHEET_MENU);
    sh.getRange(1, 1, 2, 4).setValues([
      ["商品名", "説明", "価格", "表示"],
      ["オードブル", "串焼KEMURI屋 特製オードブル", 8000, true],
    ]);
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_CONF)) {
    const sh = ss.insertSheet(SHEET_CONF);
    sh.getRange(1, 1, 10, 2).setValues([
      ["受付停止", false],  // TRUE にするとすぐに受付を止められる（FALSEに戻すと再開）
      ["受取日", "2026-08-27"],
      ["締切日", "2026-08-24"],
      ["受取開始時刻", 12],
      ["受取終了時刻", 17],
      ["受取刻み(時間)", 0.5],
      ["予約上限", 20],  // 全体で受け付ける個数の上限。達すると自動で受付停止
      ["お知らせ", "8月27日お渡し限定・ご予約は8月24日（月）まで"],
      ["写真URL", ""],  // 入れるとページの写真がこのURLに差し替わる
      ["通知メール", ""],  // 入れると新規予約のたびにメールが届く
    ]);
  }
  if (!ss.getSheetByName(SHEET_ORDER)) {
    const sh = ss.insertSheet(SHEET_ORDER);
    sh.getRange(1, 1, 1, 10).setValues([[
      "受付日時", "予約番号", "お名前", "電話番号", "受取日", "受取時間", "注文内容", "個数", "合計", "備考",
    ]]);
    sh.setFrozenRows(1);
  }
}

function conf_() {
  const sh = ss_().getSheetByName(SHEET_CONF);
  const map = {};
  sh.getDataRange().getValues().forEach(function (r) {
    if (r[0] !== "") map[String(r[0])] = r[1];
  });
  return map;
}

/** 手動の受付停止スイッチ（設定シート「受付停止」が TRUE / 停止 / ON なら止める） */
function isStop_(conf) {
  const v = conf["受付停止"];
  if (v === true) return true;
  const s = String(v || "").trim().toUpperCase();
  return s === "TRUE" || s === "ON" || s === "停止";
}

/** これまでに予約された個数の合計（「注文」シートの個数列を集計） */
function soldQty_() {
  let sold = 0;
  ss_().getSheetByName(SHEET_ORDER).getDataRange().getValues().slice(1).forEach(function (r) {
    sold += Number(r[7]) || 0;
  });
  return sold;
}

/** お客さまページが開いたときに呼ばれる：メニューと設定を返す */
function doGet() {
  ensureSheets_();
  const conf = conf_();
  const items = [];
  ss_().getSheetByName(SHEET_MENU).getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0] !== "" && r[3] === true) {
      items.push({ name: String(r[0]), desc: String(r[1] || ""), price: Number(r[2]) || 0 });
    }
  });
  const limit = Number(conf["予約上限"]) || 20;
  return json_({
    ok: true,
    items: items,
    closed: isStop_(conf),
    limit: limit,
    remain: Math.max(0, limit - soldQty_()),
    fixedDate: dateStr_(conf["受取日"], "2026-08-27"),
    deadline: dateStr_(conf["締切日"], "2026-08-24"),
    timeFrom: Number(conf["受取開始時刻"]) || 12,
    timeTo: Number(conf["受取終了時刻"]) || 17,
    timeStep: Number(conf["受取刻み(時間)"]) || 0.5,
    imageUrl: String(conf["写真URL"] || ""),
    notice: String(conf["お知らせ"] || ""),
  });
}

/** 設定シートの日付を "YYYY-MM-DD" 文字列にそろえる（Dateでも文字でもOK） */
function dateStr_(v, fallback) {
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Tokyo", "yyyy-MM-dd");
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

/** 予約の送信を受け取る */
function doPost(e) {
  ensureSheets_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = JSON.parse(e.postData.contents);
    if (!p.name || !p.tel || !p.date || !p.time || !p.items || !p.items.length) {
      return json_({ ok: false, error: "入力が足りません" });
    }
    // 手動停止中は受け付けない
    if (isStop_(conf_())) {
      return json_({ ok: false, error: "closed" });
    }

    const sh = ss_().getSheetByName(SHEET_ORDER);

    // 上限チェック（ロック中に集計するので同時アクセスでも超えない）
    const qty = p.items.reduce(function (s, x) { return s + (Number(x.qty) || 0); }, 0);
    const limit = Number(conf_()["予約上限"]) || 20;
    const remain = limit - soldQty_();
    if (qty > remain) {
      return json_({ ok: false, error: "limit", remain: Math.max(0, remain) });
    }

    // 予約番号：ページ側で発行した番号をそのまま使う（例 K0813-1338A）。
    // 万一なければサーバー側で連番を発行する
    const now = new Date();
    let orderId = String(p.orderId || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 20);
    if (!orderId) {
      const mmdd = Utilities.formatDate(now, "Asia/Tokyo", "MMdd");
      let seq = 1;
      sh.getDataRange().getValues().slice(1).forEach(function (r) {
        if (String(r[1]).indexOf("K" + mmdd + "-") === 0) seq++;
      });
      orderId = "K" + mmdd + "-" + seq;
    }

    const itemsText = p.items.map(function (x) { return x.name + "×" + x.qty; }).join(" / ");
    const total = p.items.reduce(function (s, x) { return s + Number(x.price) * Number(x.qty); }, 0);

    sh.appendRow([
      Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss"),
      orderId, String(p.name), "'" + String(p.tel), String(p.date), String(p.time),
      itemsText, qty, total, String(p.note || ""),
    ]);

    // 通知メール（設定シートにアドレスがあれば）
    const mail = String(conf_()["通知メール"] || "").trim();
    if (mail) {
      MailApp.sendEmail(
        mail,
        "【オードブル予約】" + orderId + " " + p.name + "さま " + p.date + " " + p.time,
        "予約番号：" + orderId + "\n" +
        "お名前：" + p.name + "\n" +
        "電話：" + p.tel + "\n" +
        "受取：" + p.date + " " + p.time + "\n" +
        "内容：" + itemsText + "\n" +
        "合計：¥" + total + "\n" +
        "備考：" + (p.note || "なし") + "\n" +
        "累計：" + (limit - remain + qty) + "個／上限" + limit + "個（残り" + (remain - qty) + "個）"
      );
    }

    return json_({ ok: true, orderId: orderId });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
