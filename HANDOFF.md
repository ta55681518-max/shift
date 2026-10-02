# 串焼KEMURI屋 管理システム 引き継ぎメモ（串在庫まわり）

新しいセッションで串在庫（`kushiyaki.html`）を触るときに最初に読むメモ。
システム全体の仕様はコード中の日本語コメントが一次情報。ここは要点だけ。

## 置き場所
- リポジトリ：`ta55681518-max/shift`（このリポジトリにアプリ群がまとまっている）
- 本番：**Netlify** `https://comfy-khapse-8a3cae.netlify.app/`（main に push で自動反映）
  - 旧 GitHub Pages（`ta55681518-max.github.io/shift/`）は引っ越し前。開くと `site-notice.js` が赤帯で知らせる。
  - **データは «ブラウザ × URL» ごとに別**。古いURLで開くと中身が空に見える。
- 旧アプリ zaiko（別リポジトリ）は Netlify には無い。串在庫はもう zaiko に依存しない。

## アプリと共通モジュール
- `dashboard.html`（ホーム・売上/原価/レシピ/予測）、`reitou.html`（冷凍在庫＝**POS取り込みの入口**）、
  `kushiyaki.html`（串在庫）、`hacchu.html`（発注）、`index.html`（シフト希望）
- `kemuri-core.js` → `KemuriCore`：`norm`/日付/**売上履歴 `sales`**（`kemuri_sales_v1`）
- `kemuri-data.js` → `KemuriData`：原価マスタ（`costs`、`category`＝分類）、レシピ（`recipes`）など
- `pos-source.js`：POSのCSV/貼り付けの読み取り。`kemuri-backup.js`：まとめてバックアップ
- 変えたら `?v=YYYYMMDDx` と `HTML_BUILD`/`KemuriData.BUILD` を揃える慣習（共通JSを変えたとき）

## 串在庫の出数連携（PR「串在庫を、POSの売上履歴から自動で引けるようにする」）
流れ：POS取り込みボタン/CSV → `reitou.html` が在庫を動かし、`KemuriCore.sales.record()` で売上履歴にためる
→ `kushiyaki.html` が売上履歴を読んで串を自動で引く（開いたとき・タブに戻ったとき・storage・共有pullのあと）。

- POS商品→串：①自分で結んだ `posMap`（`__skip__`＝串じゃない）＞②レシピに串が入るメニュー＞③同名の串（末尾「串」の有無は問わない）
- 二重に引かない：`posMarks['日\u0001norm(POS名)']` = もう引いた «出数»。取り込み直しは増えたぶんだけ。
- `posFrom`（いつの出数から引くか）が空のうちは自動で引かない。期間まとめの日（`sales.spanOf`）は引かない。
- `posLog` で取消可。取消は «その記録で進めたぶん» だけ台帳を戻し、自動（`posAuto`）を止める。
- スタッフ共有（GAS、KDB丸ごと last-write-wins）でも、台帳と在庫が一緒に動くので、
  古い内容で上書きされても次の自動反映で1回ぶんに戻る。売上履歴そのものは端末ごと（共有されない）。

## 残っている宿題・注意
- ダッシュボードの「明日の目安」は冷凍在庫の品目しか知らず、串は出ない。
- `kemuri-backup.js` の `describe()` に串在庫の件数表示が無い（「あり」とだけ出る）。
- 冷凍在庫で取り込みを取り消すと売上履歴から消えるが、串在庫で引いたぶんは自動では戻らない
  （必要なら串在庫の「引いた記録」で取消）。
- テスト：ヘッドレス Chromium（`/opt/pw-browsers/chromium` ＋ `/opt/node22/lib/node_modules/playwright` を `require`）。
  リポジトリを `python3 -m http.server` で配信し、同じオリジンで dashboard と kushiyaki を開いて試すと本番に近い。
