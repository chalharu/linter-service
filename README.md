# linter-service

このリポジトリの主目的は、共通の GitHub Actions から各種 Linter を実行することです。

各利用側リポジトリでは GitHub App をインストールし、その GitHub App の Webhook を Cloudflare Worker が受信します。Cloudflare Worker は Proxy としてこのリポジトリへ `repository_dispatch` を送り、このリポジトリ側の GitHub Actions がメイン処理として Linter を実行する想定です。

GitHub App からこのリポジトリへ直接 Webhook できない前提のため、Cloudflare Worker は起動 Proxy の役割を担います。

## リポジトリ構成

- `.github/workflows/repository-dispatch.yml`: `repository_dispatch` を受ける入口 workflow。現時点ではスケルトンです。
- `.github/workflows/ci.yml`: Worker 実装の型検査とテストを行います。
- `worker/`: Cloudflare Worker の実装一式です。
- `worker/wrangler.toml`: Cloudflare Worker デプロイ用の設定です。

## フロー

- GitHub App の `pull_request` と `check_run` Webhook を受信します。
  - 実装場所: `worker/src/index.ts`
- Worker が `X-Hub-Signature-256` を使って Webhook 署名を検証します。
- `pull_request` では payload から、`check_run` では必要に応じて GitHub API から、PR 元の情報を取得します。
- Worker が GitHub App の installation token を発行し、このリポジトリへ `repository_dispatch` を送信します。
- このリポジトリの GitHub Actions が、受け取った情報を使って共通 Linter を実行します。
  - 現時点では workflow はスケルトンです。

## Worker のローカル開発

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

デプロイも Worker ディレクトリ経由で実行します。

```bash
cd worker
npm run deploy
```

## Worker の環境変数

Cloudflare Workers には Secret として、ローカル開発時には `worker/.dev.vars` として設定します。

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_DISPATCH_OWNER`
- `GITHUB_DISPATCH_REPO`
- `GITHUB_DISPATCH_EVENT_TYPE` 任意。未指定時は `github_app_webhook`
- `GITHUB_DISPATCH_INSTALLATION_ID` 任意。dispatch 先が別 installation の場合に上書き
- `GITHUB_API_BASE_URL` 任意。既定値は `https://api.github.com`

通常は `GITHUB_DISPATCH_OWNER` / `GITHUB_DISPATCH_REPO` にこのリポジトリを指定します。

デプロイ前には Cloudflare 側へ Secret を登録します。

```bash
cd worker
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_DISPATCH_OWNER
wrangler secret put GITHUB_DISPATCH_REPO
wrangler secret put GITHUB_DISPATCH_EVENT_TYPE
wrangler secret put GITHUB_DISPATCH_INSTALLATION_ID
```

## `repository_dispatch` payload

Worker は `client_payload` に以下のような構造を載せます。

```json
{
  "event_name": "pull_request",
  "action": "opened",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "dispatch_installation_id": 12345,
  "repository": {
    "full_name": "octo-org/source-repo"
  },
  "pull_request": {
    "number": 42,
    "head": {
      "ref": "feature/example",
      "sha": "abc123"
    },
    "base": {
      "ref": "main",
      "sha": "def456"
    }
  },
  "check_run": {
    "name": "ci / test",
    "status": "completed",
    "conclusion": "success"
  }
}
```

`check_run` 由来でない場合、`check_run` は含まれません。

## GitHub Actions

- `.github/workflows/ci.yml` は `worker/` 配下の型検査とテストを実行します。
- `.github/workflows/repository-dispatch.yml` は受信 payload を確認し、将来の共通 Linter 実行処理を差し込むためのスケルトンです。

後者の workflow に、実際の downstream 処理を追記してください。
