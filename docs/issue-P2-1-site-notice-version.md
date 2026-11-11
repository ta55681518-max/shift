# [P2-1] `site-notice.js?v=` が2つに分かれている

`automation/backlog.md` の **A-4**。
backlog の指示どおり、**コードは変更せず**やるべきことだけまとめた Issue 案。

対応するテスト：`tests/known-gaps.test.mjs` の `[P2-1] site-notice.js の ?v= が全ファイルで揃っている`（いま `todo`）

---

## 事実（2026-11-10 時点の実測）

| ファイル | リスク区分 | `site-notice.js?v=` |
|---|---|---|
| `index.html` | review | `20261008a` |
| `order.html` | review | `20261008a` |
| `hacchu.html` | review | `20261008a` |
| `dashboard.html` | review | `20261012b` |
| `kushiyaki.html` | **blocked** | `20261012b` |
| `reitou.html` | **blocked** | `20261012b` |
| `reitou-button.html` | low | （`site-notice.js` を読み込んでいない） |

## 原因

`?v=` は PR #49（`a734df7` / 2026-09-30）で6ファイル全部に `20261008a` として入った。

その後 **PR #57（`8ea1fc7` / 2026-10-12）** が `dashboard.html` / `kushiyaki.html` / `reitou.html` の
3ファイルだけを触り、そのついでに `?v=` を `20261012b` に上げた。
`index.html` / `order.html` / `hacchu.html` はこの PR の対象外だったので `20261008a` のまま残った。

**`site-notice.js` 本体は 2026-09-26（`6f0687e`）から中身が変わっていない。**
つまり `20261012b` への上げは「中身が変わったから」ではなく、触ったファイルに合わせた機械的な上げだった。

## 影響

- **いますぐの実害は無い。** 2つのURLが指す中身は同じなので、どの画面でも同じ帯が出る。
  ブラウザが同じファイルを2つのURLで別々にキャッシュする、という無駄だけ。
- **危ないのは次に `site-notice.js` を変えたとき。**
  いまのように「触ったファイルの `?v=` だけ上げる」と、`index.html` / `order.html` / `hacchu.html` は
  古いキャッシュを出し続ける。この帯は「旧 GitHub Pages のURLで開いていますよ」と知らせる役なので、
  **古い帯が残ると、お客さま・スタッフを古いURLのまま放置することになる。**

## 直し方

次の3ファイルの1行ずつを `20261012b` に揃える。

```
index.html   : <script src="site-notice.js?v=20261008a"></script>
order.html   : <script src="site-notice.js?v=20261008a"></script>
hacchu.html  : <script src="site-notice.js?v=20261008a"></script>
                                        ↓
               <script src="site-notice.js?v=20261012b"></script>
```

`site-notice.js` の中身は変えないので、**値を上げるのではなく、遅れている3つを追いつかせる**のが正しい。

### 大事な点：blocked のファイルには触らなくてよい

backlog の A-4 には「`?v=` を書き換える先の HTML は review/blocked なので、
HTML 側の変更が必要なら Issue にまとめるだけにする」と書いてある。
だが実際に調べると、**遅れている3ファイルはすべて `review`**。
`blocked` の `kushiyaki.html` / `reitou.html` は既に `20261012b` なので**触る必要がない**。

→ この修正は「人がレビューして `develop` にマージする」だけで済む。
　 オーナーの個別承認（GAS の貼り替えのような重い承認）は要らない。

## 直ったことの確かめ方

1. 上の3ファイルを直す
2. `tests/known-gaps.test.mjs` の `[P2-1]` から `{ todo: '…' }` を外す
3. `npm test` が緑になる（`?v=` の種類が1つになったことを機械が確認する）
4. `automation/backlog.md` の **A-4** を `[x]` にする

## 関連（この Issue では直さない）

- **P2-2 / C-8**：`?v=` と `KemuriData.BUILD` が対応していない
  （`dashboard.html` は `kemuri-data.js?v=20261026r1`、`BUILD` は `2026-10-12b`）。
  こちらは「版番号の付け方の規約そのもの」を決める話で、`C-8` として別件になっている。
  **今回の P2-1 を直しても P2-2 は緑にならない。**
- `reitou-button.html` は `site-notice.js` を読み込んでいない。
  帯を出すべき画面なのかは別途の判断（この Issue の対象外）。
