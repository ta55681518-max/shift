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
- ブラウザ自動テストは未導入。実機に近い確認は下の「手で動かす」を使う。
  （以前の環境ではヘッドレス Chromium を使っていたが、いまのリポジトリには入っていない）

---

## テストの走らせ方

依存パッケージは**ゼロ**。`npm install` は要らない。Node 20 以上で動く。

```
npm test        # 全部（tests/**/*.test.mjs）
```

今の件数：**215件 / 合格202 / 失敗0 / todo13**。
`todo` は「まだ直っていないと分かっている13件」なので、**赤ではない**（下の「known-gaps」参照）。

### 一部だけ走らせる

```
npm run test:syntax     # 全HTML/JSの構文（白画面の防止）
npm run test:security   # 鍵の混入・外部通信先の許可リスト・Function の認証
npm run test:config     # localStorage キーの凍結・netlify.toml・版番号・リンク切れ
npm run test:data       # 売上履歴・原価・レシピ・POS読み取り
npm run test:backup     # ★Gate 0（バックアップの往復）

node --test tests/hacchu.test.mjs   # 1ファイルだけ
```

### どのファイルが何を守っているか

| ファイル | 守っているもの |
|---|---|
| `syntax.test.mjs` | 全HTML/JSの構文 |
| `security.test.mjs` | 鍵の混入・外部通信先の許可リスト（4ホスト）・Netlify Function の認証 |
| `config.test.mjs` | localStorage キーの凍結・`netlify.toml`・版番号・リンク切れ |
| `core-sales.test.mjs` | 売上履歴の二重取込防止・保存失敗検出・競合検出・`norm()` の固定 |
| `data-costs.test.mjs` | 原価・レシピ・単位換算・日別売上・POS CSV読み取り |
| `backup-roundtrip.test.mjs` | **★Gate 0**：書き出し→読み込みが1バイトも変わらない |
| `hacchu.test.mjs` | 発注：数量の増減・発注文の書式・発注漏れ・送信履歴 |
| `order.test.mjs` | オードブル予約：受付の開け閉め・20個上限・入力チェック・送信の失敗時 |
| `workflows.test.mjs` | ワークフロー自身の安全性（権限・上限・`main` への自動反映が無いこと） |
| `known-gaps.test.mjs` | 既知の未修正点13件（`todo`） |

**★Gate 0 だけは特別**。ここが赤いときは「バックアップから戻せなくなった」という意味で、
オーナーの実データが失われうる。**何があってもマージしない。**

### `known-gaps.test.mjs`（`todo` の意味）

直っていないことが分かっている点を、**動くテストの形で**置いてある。
`todo` が付いているので落ちても CI は赤にならない。

直したら `{ todo: '…' }` を**消して**緑にする。そこで初めて「直った」と言える。
`automation/backlog.md` の該当行も `[x]` にする。

### HTML の中のアプリをテストする

`hacchu.html` と `order.html` は本体が HTML の `<script>` の中にある。
`tests/helpers/html-app.mjs` がそれを «画面なし» で読み込む。

```js
import { loadHtmlApp, stubCalls } from './helpers/html-app.mjs';

const h = loadHtmlApp({
  file: 'hacchu.html',
  bootstrap: 'render',          // スクリプト末尾の起動行。ここだけ実行しない
  expose: ['S', 'changeQty'],   // HTML の中の let / const を外から触れるようにする
  initial: { kemuri_hacchu_v1: JSON.stringify(state) },
});
stubCalls(h.sandbox, ['render', 'toast']);   // 画面を作る関数は記録するだけにする
h.app.changeQty('p1', 1);
```

`bootstrap` に渡した名前が**スクリプトの最後の行でない**と、わざと失敗する。
HTML 側の作りが変わったことに気づかずに «中身を読まずに緑» になるのを防ぐため。

### 手で動かす

```
npm run serve          # http://localhost:8080/ で配信（ポートは引数で変えられる）
npm run serve 9000
```

本番と同じ «同一オリジン» になるので、2タブ同時に開いて競合を試すなどができる。
ブラウザの localStorage は URL ごとに別なので、**本番データには触らない**。

---

## リスク区分の読み方

`automation/risk-policy.json` が「どのファイルを自動で触ってよいか」を決めている。
強さは **blocked > review > low**。**1ファイルでも blocked に当たれば、その変更全体が blocked。**

| 区分 | 意味 | 主なファイル |
|---|---|---|
| **blocked** | 自動では触らせない。壊れるとオーナーの実データ（売上・在庫・原価・レシピ）が失われる、または安全装置そのもの | `kemuri-core.js` `kemuri-backup.js` `pos-source.js` `reitou.html` `kushiyaki.html` `netlify.toml` `netlify/**` `.github/**` `package.json` `CODEOWNERS` `.gitignore` `automation/risk-policy.json` |
| **review** | 表示や計算に影響するが保存形式は変えない。人が差分を見てからマージ | `kemuri-data.js` `dashboard.html` `hacchu.html` `index.html` `order.html` |
| **low** | テスト・ドキュメント・お知らせ帯。壊れても実データに影響しない | `tests/**` `docs/**` `HANDOFF.md` `AUTOMATION.md` `site-notice.js` `automation/backlog.md` ほか |

**どの区分にも載っていないファイルは `unknown` になり、安全側に倒して blocked になる。**
新しいファイルを足して自動で扱わせたいときは、`risk-policy.json` の `low.patterns` に追記が必要
（`risk-policy.json` 自体の変更はオーナー承認が必要）。

### 自分の変更がどの区分か調べる

```
node automation/classify-risk.mjs origin/develop        # git diff から判定
node automation/classify-risk.mjs --files tests/a.mjs   # ファイルを直接指定
node automation/classify-risk.mjs origin/develop --json # 内訳つき
```

終了コード：`0` low ／ `1` review ／ `2` blocked ／ `3` 判定できなかった（blocked 扱い）。

### 変更量の上限

`risk-policy.json` の `limits`。超えると人が見る。

- 変更ファイル数 8
- 追加行 600
- 削除行 300

### blocked のファイルを直したいとき

自動開発（AI）は**コードを変更せず、やるべきことを Issue にまとめるだけ**にする。
`automation/backlog.md` の 🔴 区分がその一覧。GAS（Googleスプレッドシート）の貼り替えは
さらに**オーナーの個別承認**が必要。
