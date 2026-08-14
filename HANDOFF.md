# 串焼き在庫アプリ 引き継ぎ書（串焼KEMURI屋）

新しいセッションの最初に、この内容を貼るか、リポジトリに置いて読ませてください。

---

## 0. これは何のプロジェクト
串焼き店「串焼KEMURI屋」の **串の在庫管理アプリ**（1ファイルのHTML）。
既存の E-POS連動の在庫アプリ「**zaiko**」と連携し、**E-POSの出数 → 串の在庫を自動で引く**のが目的。

## 1. リポジトリ / URL / ブランチ
- 串在庫アプリ本体：`ta55681518-max/shift` の **`kushiyaki.html`**
  - 本番URL：`https://ta55681518-max.github.io/shift/kushiyaki.html`
- zaiko（E-POS在庫アプリ、参照/連携先）：`ta55681518-max/zaiko` の `index.html`
  - 本番URL：`https://ta55681518-max.github.io/zaiko/`
- （同リポジトリの `index.html` は別物＝シフト希望アプリ。今回は触っていない）
- 作業ブランチ：**`claude/yakitori-inventory-app-jk54vc`**（PRは毎回 main へマージ運用）
- 本番反映：GitHub Pages（main にマージ後、数分で反映）
- ⚠️ このセッションのプロキシは `*.github.io` への直接アクセスを組織ポリシーで**遮断**（403）。デプロイ済みページはfetch不可。動作確認は headless Chromium（`/opt/pw-browsers/chromium`＋`/opt/node22/lib/node_modules/playwright` を CommonJS `require`）でローカルファイルを開いて行う。

## 2. これまでにマージ済み（本番反映済み）の主な変更
- 串在庫アプリ本体（ロット/消費期限/ロス/原価、プルダウン・カレンダー、ロット一覧、廃棄=本数/ロット別）
- zaikoへ本数を書き戻す機能、原価は「1本あたり」/「グラム計算」の2モード
- **スタッフ共有**（Googleシート＋GAS、last-write-wins）
- **参加リンク**（`kushiyaki.html#s=<base64のGAS URL>` を開くだけで共有に自動接続）… PR#7
- **出数反映を「材料使用量（レシピ換算）」からできるように**（既定=material）… PR#8
- **レシピの材料名（＝串）を「どれを串として管理する？」候補に出す**（POS名に「串」が無くても拾える）… PR#9
- **共有ON/OFFを全タブ上部に常時表示**（バー、`renderShareBar`）… PR#10
- **ホーム画面アイコンを KEMURI屋 ロゴ画像に**（アップロードされた `串在庫管理アプリアイコン.png` を 180/192/512 に焼き込み。manifest `display:"browser"`）… PR#11（最新）

## 3. アーキテクチャ要点（超重要）
- **同一オリジン localStorage 連携**：shift も zaiko も host が `ta55681518-max.github.io` で**同一オリジン**。だから串在庫は `localStorage['kemuri_zaiko_v1']` を直接読める。
  - 串在庫キー：`kemuri_kushiyaki_v1`（KDB）
  - zaikoキー：`kemuri_zaiko_v1`（DB）、控えsnapshot：`kemuri_zaiko_snapshot`
  - 共有URL保存：`kemuri_kushiyaki_share`
- **zaikoの出数（DB.days[日付]）はブラウザローカルのみ。共有（GAS）では飛ばない。**
- **スタッフ共有（GAS）は串在庫KDB（串登録・在庫・ロット・applied）だけを同期。** 出数は同期しない。
- GAS：`doGet` が A1(JSON)/B1(rev) を返す。`doPost` は **baseRev を見ずに毎回上書き**（＝競合検知なし＝last-write-winsで**古い端末が後から保存すると上書き**される）。
- 反映モード：`KDB.reflectBy = 'material'|'sales'`
  - material：zaikoの `recipes`（分量）× `days`（出数）を再計算 → 串名に一致する材料使用量を FEFO で引く（`usageDetail`/`usedOn`）
  - sales：`days`の商品名 == 串名 で 出数×`per` を引く（`soldOn`）
- 反映は**手動ボタン**（`applyReflect`）。二重引き防止で `KDB.applied[日付]` があると**何もしない**。取消は `undoReflect`（記録slicesを`restore`で戻す）。

## 4. いま「反映されない」の根本原因（今回いちばん重要）
症状が回ごとに違ったが、原因は次の複合：
1. **端末/ブラウザがバラバラ**。E-POS出数を入れる zaiko と、串在庫を開くブラウザが**別**だと、出数はそのブラウザに無い＝「zaikoに出数が無いさ」。
   - ユーザーは Chrome / Safari / ホーム画面アイコン等を混在使用。**鉄則＝出数を入れるブラウザと串在庫を開くブラウザを“同じ1つ”に固定**。
2. **串登録が共有頼み**。串の15種はローカルではなく共有シート側にあり、共有OFFにすると「串の登録 0種」になる（直近の画面がこれ）。
3. **共有の上書き**。GASに競合検知が無く、古い数字を持った別端末/タブが後から保存すると、反映で引いた在庫が**元に戻る**（applied記録だけ残り在庫は満タン、という状態を実際に確認）。
4. **反映ロック**。対象日が「（反映ずみ）」だと「この日を反映する」を押しても無反応（正常仕様）。減らないと誤解しやすい。
5. 直近の共有シート「串在庫管理」は A1 が空だった（データは別タブ `kushiyaki` に入る設計。空なら共有復元で串は戻らない）。共有URL（GASの `/exec`）はユーザーが失念中で、Apps Scriptの「デプロイを管理」から取得しようとしていた段階。

### 動作自体は正しいことを検証済み
headless で「未反映の日を反映 → 在庫が正しく減る」「取消→再反映で正しく戻る/引く」を確認済み（`consume`/`doReflect`/`undoReflect` にバグ無し）。**問題は運用（同一ブラウザ・共有上書き・ロック）**。

## 5. 推奨する次の一手（新セッションでの進め方）
まず**基本フローを1台・共有OFFで成立させる**のが最短：
1. 1つのブラウザ（例：iPhoneのChrome）に固定
2. そのブラウザで zaiko を開き、E-POS出数を貼って保存
3. 同じブラウザで串在庫を開く → 「串の設定・連携」→「どれを串として管理する？」で串を手タップ登録（POS名に「串」が無いので自動選択は不可）
4. 「串の在庫」で各串に仕込み本数を入れる
5. 「出数を反映」→ 反映のもと（material ならレシピ登録が必要／sales なら商品名=串名で拾える）→ 日付選択 → 中身を見る → この日を反映する
6. 在庫が減れば成立。**ここまで共有はOFFのまま**。安定してから共有を足す。

### 未対応の要望
- **「zaikoのジャンル(串)から商品を一括登録」**：zaikoは現状ジャンル/部門/カテゴリを**保存していない**（E-POS取り込みで商品名+出数のみ、カテゴリ列は SKIP_WORDS で捨てる）。実現には (a) E-POSの集計にジャンル列があるか確認 →(b) zaikoの取り込みにジャンル保存を追加 →(c) 串在庫に「このジャンルをまとめて登録」を追加、が必要。**E-POS集計にジャンル/部門列があるかのスクショ待ち**。
- **共有の上書き対策**：GASに baseRev 競合検知を入れて古い上書きを弾く／反映時に即push＆pull保護、等（要相談。GAS再デプロイが必要＝ユーザー手作業）。
- **反映ロックのUX改善**：反映ずみ日を押したとき無反応→「取り消して引き直す」導線を出す等。

## 6. 主要ファイル / 関数 / 場所（kushiyaki.html）
- アイコン：head の `<!-- app-icons -->` ブロック（apple-touch-icon 180 / icon 192 / manifest。`display:"browser"` 維持＝iOSでもSafari起動でzaiko同一オリジン共有を保つ）
- データ：`KDB = {items, applied, log, losses, seq, syncZaiko, reflectBy}`、`items[名]={min,par,per,cost,costMode,gPer,gPrice,keep,lots:[{id,made,exp,qty}]}`
- 在庫：`stockOf` `lotOrder(FEFO)` `consume` `consumeFromLot` `restore` `costOf`
- zaiko連携：`readZaiko` `zaikoIsLive` `zProducts`（recipesキー+menus+days商品名+**recipe材料名**）`zMaterials` `zDays` `syncToZaiko`
- 反映：`soldOn` `usageDetail`/`usedOn`（material）`consumedOn` `setReflectBy` `previewReflect`（未登録材料は「＋タップで追加」= `addKushiFromMaterial`）`doReflect` `applyReflect` `applyAllUnreflected` `undoReflect`
- 共有：`SHARE{url,rev,pushing,dirty,timer,lastSync,err,loop}` `schedulePush` `pushShared` `pullShared`（dirty中はpullしない）`saveShareUrl`（既存データありなら「読み込む/上げる」を選ばせる）`stopShare` `syncNowShare` `startShareLoop`（20s+focus）`renderShareBar`（全タブ上部ON/OFF帯）`copyJoinLink`/`applyJoinHash`（参加リンク）`GAS_SRC`（貼付用GAS、SHEET_NAME='kushiyaki'）
- 起動：末尾の「起動」ブロック（`normalizeItems`→`renderStock`→`applyJoinHash`→`renderShareBar`→共有ONならpull）

## 7. 環境メモ
- headlessテスト例：`node` で `require('/opt/node22/lib/node_modules/playwright')`、`chromium.launch({executablePath:'/opt/pw-browsers/chromium'})`、`file:///home/user/shift/kushiyaki.html` を開き、`localStorage` を addInitScript で仕込んで `evaluate` で関数を直接呼ぶ。
- git：作業ブランチ `claude/yakitori-inventory-app-jk54vc`。mainにマージ済みが多いので、続きは `git fetch origin main && git checkout -B <branch> origin/main` から。PR作成→ユーザーが「マージして」。
- ユーザーはPC（Windows, Chrome）とiPhoneを併用。日本語で対応。焦らせず1つずつ。
