# Cloudflare Worker Webhook Proxy

このディレクトリには、GitHub App の Webhook を受けて `repository_dispatch` を送る Cloudflare Worker の実装を置いています。

GitHub App からこのリポジトリへ直接 Webhook できない前提のため、Worker が Proxy として動作します。

## GitHub Apps の役割分担

### `linter-service-dispatcher`

- 利用場所: Cloudflare Worker
- Install 先: このリポジトリ
- Webhook: なし
- 権限:
  - `Contents: write`
  - `Metadata: read`

Worker はこの App の credentials を使って、このリポジトリへ `repository_dispatch` を送信します。

### `linter-service-checker`

- 利用場所: `.github/workflows/repository-dispatch.yml`
- Install 先: 各利用リポジトリ
- Webhook: Cloudflare Worker
  - `Pull request`
  - `Check run`
- 権限:
  - `Checks: write`
  - `Contents: read`
  - `Pull requests: read`
  - `Metadata: read`

Cloudflare Worker はこの App の webhook secret で署名検証を行います。`repository_dispatch.yml` ではこの App の credentials を使って、source repository に対する API 操作を行う想定です。

## 役割

- `linter-service-checker` の `pull_request` / `check_run` Webhook を受信する
- `X-Hub-Signature-256` を使って webhook 署名を検証する
- `pull_request` は payload から PR 情報をそのまま取り出す
- `check_run` は関連 PR 番号と check_run metadata を取り出す
- `linter-service-dispatcher` の installation token を取得する
- このリポジトリへ `repository_dispatch` を送信する

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

## Worker の環境変数

Cloudflare Workers には Secret として、ローカル開発時には `worker/.dev.vars` として設定します。

- `GITHUB_DISPATCHER_APP_ID`
- `GITHUB_DISPATCHER_APP_PRIVATE_KEY`
- `GITHUB_CHECKER_WEBHOOK_SECRET`
- `GITHUB_DISPATCH_OWNER`
- `GITHUB_DISPATCH_REPO`
- `GITHUB_API_BASE_URL` 任意。既定値は `https://api.github.com`

`repository_dispatch` の `event_type` は固定で `github_app_webhook` を使います。

dispatcher App は install 先がこのリポジトリに固定されている前提なので、Worker は `GITHUB_DISPATCH_OWNER` / `GITHUB_DISPATCH_REPO` から installation を解決します。そのため `GITHUB_DISPATCH_INSTALLATION_ID` のような追加設定は不要です。

デプロイ前には Cloudflare 側へ Secret を登録します。

```bash
cd worker
wrangler secret put GITHUB_DISPATCHER_APP_ID
wrangler secret put GITHUB_DISPATCHER_APP_PRIVATE_KEY
wrangler secret put GITHUB_CHECKER_WEBHOOK_SECRET
wrangler secret put GITHUB_DISPATCH_OWNER
wrangler secret put GITHUB_DISPATCH_REPO
```

## `repository_dispatch.yml` 側の secrets

このリポジトリの GitHub Actions では、checker App 用に以下の secrets を使います。

- `CHECKER_APP_ID`
- `CHECKER_PRIVATE_KEY`

workflow は `client_payload.repository.owner.login` と `client_payload.repository.name` を使って、source repository に対する checker App token を取得します。

## `repository_dispatch` payload

Worker は `client_payload` に以下のような構造を載せます。

### `pull_request` event

```json
{
  "event_name": "pull_request",
  "action": "opened",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "repository": {
    "full_name": "octo-org/source-repo",
    "name": "source-repo",
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
  }
}
```

### `check_run` event

```json
{
  "event_name": "check_run",
  "action": "completed",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "repository": {
    "full_name": "octo-org/source-repo",
    "name": "source-repo",
    "owner": {
      "login": "octo-org",
      "type": "Organization"
    }
  },
  "pull_request": {
    "number": 42
  },
  "check_run": {
    "name": "ci / test",
    "status": "completed",
    "conclusion": "success",
    "head_sha": "abc123"
  }
}
```

`pull_request` event では `pull_request` に head/base を含む詳細を入れます。

`check_run` event では Worker は source repository への追加 API call を行わないため、`pull_request` には関連 PR の `number` を最低限載せ、必要な詳細は `repository_dispatch.yml` 側で checker App token を使って取得する想定です。

## 関連ファイル

- `src/index.ts`: Worker 本体
- `test/index.test.ts`: webhook 検証と dispatch 処理のテスト
- `wrangler.toml`: Cloudflare Workers 設定
- `.dev.vars.example`: ローカル開発用の環境変数サンプル
