# 承認必須の自動開発

すべての変更はテスト、リスク判定、人のPR承認、手動マージを必要とします。低リスクでも自動マージしません。

## 現在の状態

developには未pushの変更があります。ローカルの検証・コミットと、GitHubへのpush・本番公開は別の段階です。
個人用の .claude/settings.json と .claude/settings.local.json は共有せず、CI専用の .claude/ci-settings.json だけを管理します。

## テスト

Node 24で npm test と npm run test:backup を実行します。依存のインストールは不要です。
リスク確認は node automation/classify-risk.mjs --files 対象ファイル、Git差分の確認は node automation/classify-risk.mjs origin/main です。
判定器の終了コード3は判定不能です。CIは automation/check-risk.mjs で終了コードとJSON出力を検証し、判定不能・不正・空の出力で停止します。low/review/blockedはレビュー優先度であり、いずれも人の承認が必要です。

## Claudeによる変更とPR作成

claude-daily.yml は手動実行のみです。自動開発を始める前に ai-development 環境の承認が必要です。定期実行は無効にしました。
claude-mention.yml はイベント実行者がオーナーの場合だけ対象です。Issue作成者がオーナーでも、第三者のコメントは起動条件にしません。
ANTHROPIC_API_KEYは今回登録していません。ai-development環境にはオーナーの承認を設定済みです。AIの課金実行は別途明示承認を得てから行ってください。
Claude GitHub Appの導入状態とモデルの利用可否は、初回の承認付き実行前に確認が必要です。

## GitHubの承認と保護

main/developにPR必須、承認1件、古い承認の取り消し、会話解決必須、force pushと削除禁止を設定済みです。ルールセットのバイパスはありません。
CIが導入された後は必須チェックに「全体の合否」と「Gate 0（バックアップの往復）」を追加してください。導入前の未実行チェックは先に必須化しません。
PR作成者は自分のPRを承認できません。オーナー本人のPRでは別の承認者が必要で、CODEOWNERS導入後は別のコードオーナーも必要です。AI作成PRをオーナーが承認する運用を基本とします。
CODEOWNERSはベースブランチに導入された後に有効になります。

## Codexレビュー

ChatGPTのコードレビュー設定で ta55681518-max/shift の自動レビューを有効にします。AGENTS.mdで保存互換性、認証、権限変更の確認を指示します。Codexレビューは必須の人の承認を置き換えません。

## 公開前に必要な明示承認

1. developへのpush（未pushコミット全体と公開対象ブランチ設定を確認してから）。
2. Secrets登録とAIの課金を伴う初回実行。
3. developからmainへのマージと、それに伴う本番公開。

GitHub Actionsの通常トークンで作ったPRは別ワークフローが自動起動しない場合があります。Claude GitHub AppのトークンでのPR作成を確認してください。
