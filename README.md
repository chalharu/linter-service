# linter-service

このリポジトリの主目的は、共通の GitHub Actions から各種 Linter を実行することです。

各利用側リポジトリでは GitHub App をインストールし、その Webhook を Cloudflare Worker が受けます。Worker は Proxy としてこのリポジトリへ `repository_dispatch` を送り、このリポジトリ側の GitHub Actions が共通 Linter を実行します。このリポジトリ自身の PR は `pull_request` trigger で直接処理し、Worker は self-dispatch を送らない想定です。

## 主な場所

- `.github/workflows/repository-dispatch.yml`: `repository_dispatch` とこのリポジトリ自身の `pull_request` を受けて changed files から対象 linter を選ぶ router workflow
- `.github/workflows/lint-*.yml`: linter ごとの reusable workflow
- `.github/workflows/ci.yml`: `worker/` 配下の型検査とテスト
- `worker/`: GitHub App Webhook を受けて `repository_dispatch` を送る Cloudflare Worker

## Worker の詳細

Worker の実装・設定・ローカル開発・デプロイ方法は `worker/README.md` を参照してください。
