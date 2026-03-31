# Cloudflare Worker Webhook Proxy

このディレクトリには、GitHub App の Webhook を受けて `repository_dispatch` を送る Cloudflare Worker の実装を置いています。

GitHub App からこのリポジトリへ直接 Webhook できない前提のため、Worker が Proxy として動作します。

## 役割

- GitHub App の `pull_request` と `check_run` Webhook を受信する
- `X-Hub-Signature-256` を使って Webhook 署名を検証する
- `pull_request` は payload から、`check_run` は必要に応じて GitHub API から PR 元情報を取得する
- GitHub App の installation token を発行する
- 設定済みリポジトリへ `repository_dispatch` を送信する

通常は `GITHUB_DISPATCH_OWNER` / `GITHUB_DISPATCH_REPO` にこのリポジトリを指定し、ルート側の GitHub Actions が共通 Linter を実行します。

## ローカル開発

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

検証は以下で行えます。

```bash
cd worker
npm run check
```

## デプロイ

```bash
cd worker
npm run deploy
```

`wrangler.toml` はこのディレクトリにあります。

## 環境変数

Cloudflare Workers には Secret として、ローカル開発時には `worker/.dev.vars` として設定します。

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_DISPATCH_OWNER`
- `GITHUB_DISPATCH_REPO`
- `GITHUB_DISPATCH_EVENT_TYPE` 任意。未指定時は `github_app_webhook`
- `GITHUB_DISPATCH_INSTALLATION_ID` 任意。Webhook を受けた repo の installation とは別の installation で dispatch 先 repo にアクセスする必要がある場合だけ指定
- `GITHUB_API_BASE_URL` 任意。既定値は `https://api.github.com`

通常必要なのは `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` / `GITHUB_DISPATCH_OWNER` / `GITHUB_DISPATCH_REPO` です。

`GITHUB_DISPATCH_EVENT_TYPE` は `repository_dispatch` の `event_type` を上書きしたい場合のためのオプションです。現在の実装では未指定でも `github_app_webhook` が使われるため、通常は不要です。

`GITHUB_DISPATCH_INSTALLATION_ID` は、Webhook 元 repo の `installation.id` では dispatch 先 repo にアクセスできない場合のためのオプションです。例えば、Worker が複数 owner の repo から Webhook を受ける一方で、dispatch 先がこのリポジトリに固定されていて、その repo へアクセスできる GitHub App installation が別にある場合に使います。

デプロイ前には Cloudflare 側へ Secret を登録します。

```bash
cd worker
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_DISPATCH_OWNER
wrangler secret put GITHUB_DISPATCH_REPO
# Optional:
# wrangler secret put GITHUB_DISPATCH_EVENT_TYPE
# wrangler secret put GITHUB_DISPATCH_INSTALLATION_ID
```

## `repository_dispatch` payload

Worker は `client_payload` に以下のような構造を載せます。

ルート側の `repository_dispatch` workflow では、この metadata の `repository.owner.login` を使って GitHub App token を取得します。

```json
{
  "event_name": "pull_request",
  "action": "opened",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "dispatch_installation_id": 12345,
  "repository": {
    "full_name": "octo-org/source-repo",
    "owner": {
      "login": "octo-org",
      "type": "Organization"
    }
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

## 関連ファイル

- `src/index.ts`: Worker 本体
- `test/index.test.ts`: webhook 検証と dispatch 処理のテスト
- `wrangler.toml`: Cloudflare Workers 設定
- `.dev.vars.example`: ローカル開発用の環境変数サンプル
