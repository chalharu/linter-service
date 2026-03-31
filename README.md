# linter-service

このリポジトリは共通 lint 実行基盤です。
複数リポジトリの PR をまとめて受けます。
Cloudflare Worker が dispatch を中継します。
GitHub Actions が共通ルールで lint します。

## 全体像

```text
利用リポジトリの PR
        |
        v
 GitHub App Webhook
        |
        v
 Cloudflare Worker
        |
        v
 repository_dispatch
        |
        v
 共通 lint workflow
```

- 外部リポジトリの PR は Worker 経由で処理します。
- このリポジトリ自身の PR は `pull_request` で処理します。
- Worker は self-dispatch を送らず、二重実行を防ぎます。

## 主な場所

| パス | 役割 |
|------|------|
| `.github/workflows/repository-dispatch.yml` | router workflow |
| `.github/workflows/lint-*.yml` | linter ごとの reusable workflow |
| `.github/workflows/ci.yml` | `worker/` の型検査・lint・テスト |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 詳細

- Worker の設定と運用は `worker/README.md` を参照してください。
- 共有 lint の入口は `repository-dispatch.yml` です。
