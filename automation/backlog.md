# 自動開発の作業キュー

毎日の自動開発ワークフロー（`.github/workflows/claude-daily.yml`）は、
**このファイルの上から順に、まだ終わっていない項目を1つだけ**取って作業する。

- 1回の実行で扱うのは **1項目だけ**。まとめて直さない。
- `tests/known-gaps.test.mjs` の対応するテストから `todo` を外し、緑にして初めて「完了」。
- `automation/risk-policy.json` で **blocked** のファイルに触る必要がある項目は、
  AI は **コードを変更せず、やるべきことを Issue にまとめるだけ**にする。
- 完了したら、この行の `[ ]` を `[x]` にして、PR に含める。

---

## 🟢 いますぐ自動で進めてよい（低リスク）

- [ ] **A-1** `tests/` のカバレッジを増やす。`hacchu.html`（発注）のロジックに単体テストが無い。
      `S.order` / `changeQty` / `missingItems` / `buildOrderText` を `tests/hacchu.test.mjs` として起こす。
      ※ `hacchu.html` 本体は触らない。テストを足すだけ。
- [ ] **A-2** `tests/` に `order.html`（オードブル予約）の `validate()` 相当のテストを足す。
      電話番号10〜11桁・数量上限20個・合計金額の計算を固定する。
- [ ] **A-3** `HANDOFF.md` に「テストの走らせ方」と「リスク区分の読み方」の節を追記する。
- [ ] **A-4** `site-notice.js` の `?v=` 不一致を解消する（`tests/known-gaps.test.mjs` の **P2-1**）。
      ※ `site-notice.js` 自体は low。ただし `?v=` を書き換える先の HTML は review/blocked なので、
      **HTML 側の変更が必要なら Issue にまとめるだけ**にする。

## 🟡 人のレビュー付きで進める（review）

- [ ] **B-1** `kemuri-data.js` の `Costs.save` / `Recipes.save` に読み戻し検証を入れる（**P1-1 / P1-2**）。
      `writeLS` を「書く → 読み戻して照合」に変え、`set` / `remove` / `importRows` が成否を返すようにする。
      **`Daily.importRows` の戻り値の `saved` キーは名前を変えない**（`reitou.html` が見ている）。
- [ ] **B-2** `kemuri-data.js` の `Costs` / `Recipes` に競合検出を入れる（**P1-4**）。
      読んだときの生文字列を持ち、書く直前に照合して、違えば書かずに知らせる。
- [ ] **B-3** `kemuri-data.js` の `Costs.importRows` が1行ごとに保存している（N回書き込み）のを1回にまとめる。
      途中失敗で半分だけ入る状態をなくす。
- [ ] **B-4** `dashboard.html` の `saveDailyCsv()` が `res.saved` を見ていない。
      保存失敗時に「登録しました」を出さないようにする。
- [ ] **B-5** `hacchu.html` に他アプリへのナビゲーションを足す（**P2-7**）。
- [ ] **B-6** `dashboard.html` / `hacchu.html` に版表示（`HTML_BUILD`）を足す（**P2-4**）。

## 🔴 自動では触らない（blocked：Issue にまとめるだけ）

AI はこれらのファイルを**編集してはいけない**。
やるべきことを整理して Issue に書き、オーナーの判断を待つ。

- [ ] **C-1** `kushiyaki.html` の `save()` に読み戻し検証を入れ、`posApply()` が保存失敗時に
      `posMarks` を進めないようにする（在庫が「引いた扱いだが実際は引かれていない」を防ぐ）。
- [ ] **C-2** `kushiyaki.html` の `storage` イベント監視に `KKEY`（串在庫自身）を追加する。
- [ ] **C-3** `kushiyaki.html` の `posMarks` のサイズを設定画面に表示し、
      共有JSONが Googleスプレッドシートのセル上限（5万文字）に近づいたら警告する（**P3-2**）。
      ※ 剪定・削除は行わない（オーナー指示：Phase 1 は警告のみ）。
- [ ] **C-4** 串在庫の在庫不足分が消える問題：`consume()` の `short` を記録に残す。
- [ ] **C-5** 冷凍在庫の取消 → 串在庫の `posMarks` 戻し連携。
- [ ] **C-6** `kemuri-backup.js` の `KEYS` に `kemuri_kushiyaki_share` を追加（**P1-5**）、
      `describe()` に串在庫・発注の件数表示を追加（**P1-6**）。
- [ ] **C-7** `kushiyaki.html` の `GAS_SRC` を楽観ロック対応にする（**P3-1**）。
      **GAS の貼り替え・再デプロイはオーナーの個別承認が必要。** 差分案を Issue に出すだけ。
- [ ] **C-8** 版番号の規約（`?v=` と `BUILD` を揃える）を整える（**P2-2 / P2-3**）。
- [ ] **C-9** `reitou.html` の `it.cost` が未使用（**P2-5**）。使うか消すかを決める。

---

## 自動開発ワークフローへの指示（要約）

1. このファイルを上から読み、**最初の未完了項目**を1つ選ぶ。
2. 🔴 の項目なら、**コードは変更せず** Issue を1つ作って終わる。
3. 🟢🟡 の項目なら、該当ファイルだけを編集する。
4. `npm test` が **緑**になるまで直す。赤のままなら PR を作らず、原因を Issue に書いて終わる。
5. `node automation/classify-risk.mjs origin/develop` を実行し、
   `blocked` が出たら「触ってはいけないファイルを触った」ので変更を取り消す。
6. `develop` 向けに PR を作る。本文に「何を・なぜ・テスト結果」を書く。
7. `main` には絶対に PR を作らない。
