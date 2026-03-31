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
  - `Issues: write`
  - `Pull requests: read`
  - `Metadata: read`

Cloudflare Worker はこの App の webhook secret で署名検証を行います。`repository_dispatch.yml` ではこの App の credentials を使って、PR metadata の取得、対象ソース repository の checkout、集約 PR comment の更新、共通 processing check run の更新を行います。

## 役割

- `linter-service-checker` の `pull_request` / `check_run` Webhook を受信する
- `X-Hub-Signature-256` を使って webhook 署名を検証する
- `pull_request` は payload から PR 情報をそのまま取り出す
- `check_run` は関連 PR 番号と check_run metadata を取り出す
- `linter-service-dispatcher` の installation token を取得する
- このリポジトリへ `repository_dispatch` を送信する
- downstream workflow が changed files に応じて linter を選び、結果を対象 PR comment に返せるようにする

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
npm run lint
npm run check
```

`npm run check` には TypeScript の型検査、Biome lint、Vitest が含まれます。

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

`GITHUB_DISPATCHER_APP_PRIVATE_KEY` には GitHub App からダウンロードした PEM をそのまま使えます。`-----BEGIN RSA PRIVATE KEY-----` と `-----BEGIN PRIVATE KEY-----` のどちらも対応します。

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

これらの secrets を使う jobs は `checker-app` environment に関連付けています。必要に応じて GitHub 側でも同名 environment を作成し、protection rules や environment secrets に移行してください。

`repository_dispatch` 経由では workflow は `client_payload.repository.owner.login` と `client_payload.repository.name` を使って PR repository 用 token を取得し、PR details から head/source repository を解決します。このリポジトリ自身の `pull_request` event でも同じ workflow を直接実行でき、その場合は `github.event` から同等の情報を解決します。Worker は dispatch 先と同じ repository から来た webhook を送信せず、このリポジトリの PR が `pull_request` trigger と `repository_dispatch` trigger の両方で二重実行されることを避けます。

また `repository_dispatch.yml` は declarative な linter 定義から changed files を評価し、共通の in-progress check run を作成してから reusable linter workflow を並列実行します。現在の共通 linter は `actionlint`、`action-shellcheck`、`biome`、`ghalint`、`spectral`、`taplo`、`yamllint`、`zizmor` です。個別 workflow は lint 実行結果だけを返し、最終的な PR comment の upsert と processing check run の success/failure 更新は `repository_dispatch.yml` 側で一括して行います。このリポジトリの PR では `pull_request` trigger、外部リポジトリでは Worker からの `repository_dispatch` trigger を使います。private repository を前提に、workflow logs には repository 名や changed file 一覧、lint diagnostics を極力出さず、詳細は PR comment に寄せます。`spectral` は source repository に `.spectral.*` がない場合、OpenAPI / AsyncAPI 向けのデフォルト ruleset を使います。

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
    "full_name": "octo-org/pr-repo",
    "name": "pr-repo",
    "owner": {
      "login": "octo-org",
      "type": "Organization"
    }
  },
  "pull_request": {
    "number": 42,
    "head": {
      "ref": "feature/example",
      "sha": "abc123",
      "repo": {
        "full_name": "octocat/forked-repo",
        "name": "forked-repo",
        "owner": {
          "login": "octocat",
          "type": "User"
        }
      }
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
    "full_name": "octo-org/pr-repo",
    "name": "pr-repo",
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

`repository` は PR が属する repository を表します。fork PR のように source repository が異なる場合は、`pull_request.head.repo` を source repository として扱います。

`pull_request` event では `pull_request` に head/base を含む詳細を入れます。

`check_run` event では Worker は source repository への追加 API call を行わないため、`pull_request` には関連 PR の `number` を最低限載せ、必要な詳細は `repository_dispatch.yml` 側で checker App token を使って取得する想定です。なお `linter-service:` で始まる `external_id` を持つ self-generated な check run は Worker 側で無視し、通知用 check run が再び `repository_dispatch` を起動しないようにしています。また dispatch 先 repository 自身の webhook も Worker 側で無視し、このリポジトリでは direct `pull_request` trigger を正とします。

## 関連ファイル

- `src/index.ts`: Worker 本体
- `test/index.test.ts`: webhook 検証と dispatch 処理のテスト
- `wrangler.toml`: Cloudflare Workers 設定
- `.dev.vars.example`: ローカル開発用の環境変数サンプル
