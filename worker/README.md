# Cloudflare Worker Webhook Proxy

この Worker は webhook の受け口です。
GitHub App の通知を安全に検証します。
必要な PR 情報を payload に整えます。
このリポジトリへ dispatch を送り lint を起動します。

## 全体図

```text
checker App Webhook
        |
        v
 Cloudflare Worker
   | 署名検証
   | payload 整形
   v
 repository_dispatch
        |
        v
 repository-dispatch.yml
        |
        v
 lint-common.yml
         |
         v
 linter shell scripts
         |
         v
 PR comment / check run 更新
```

外部リポジトリの PR は Worker 経由で流れます。
このリポジトリ自身の PR は direct trigger で流れます。
Worker は self-dispatch と self-webhook を捨てます。
これで二重起動と再帰起動を防ぎます。

## GitHub Apps

| App | Install 先 | 主な用途 |
|-----|------------|----------|
| `linter-service-dispatcher` | このリポジトリ | Worker から `repository_dispatch` を送る |
| `linter-service-checker` | 各利用リポジトリ + このリポジトリ | PR 情報取得、checkout、comment、check run 更新 |

- `dispatcher` の権限: `Contents: write`, `Metadata: read`
- `checker` の権限: `Checks: write`, `Contents: read`, `Pull requests: write`, `Metadata: read`
- `checker` の webhook は `Pull request` と `Check run` を受けます。

Worker は checker App の secret で署名を見ます。
dispatch の送信は dispatcher App token で行います。
workflow の書き込みは checker App token で行います。
workflow `permissions` は `{}` のまま保ちます。

## セットアップ

### 1. ローカル起動

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

### 2. ローカル確認

```bash
cd worker
npm run lint
npm run check
```

### 3. Cloudflare Secret 登録

```bash
cd worker
wrangler secret put GITHUB_DISPATCHER_APP_ID
wrangler secret put GITHUB_DISPATCHER_APP_PRIVATE_KEY
wrangler secret put GITHUB_CHECKER_WEBHOOK_SECRET
wrangler secret put GITHUB_DISPATCH_OWNER
wrangler secret put GITHUB_DISPATCH_REPO
```

### 4. デプロイ

```bash
cd worker
npm run deploy
```

ローカルでは `.dev.vars` に値を入れて使います。
Cloudflare では同じ値を Secret として入れます。
dispatcher App の installation は owner/repo から引きます。
追加の installation ID 設定は不要です。

## Worker の環境変数

| 変数名 | 必須 | 用途 |
|--------|------|------|
| `GITHUB_DISPATCHER_APP_ID` | ✅ | dispatcher App の ID |
| `GITHUB_DISPATCHER_APP_PRIVATE_KEY` | ✅ | dispatcher App の PEM 秘密鍵 |
| `GITHUB_CHECKER_WEBHOOK_SECRET` | ✅ | checker App の webhook secret |
| `GITHUB_DISPATCH_OWNER` | ✅ | dispatch 先 owner |
| `GITHUB_DISPATCH_REPO` | ✅ | dispatch 先 repository 名 |
| `GITHUB_API_BASE_URL` | 任意 | 既定値は `https://api.github.com`。指定時は HTTPS のみ許可します。 |

- `event_type` は `github_app_webhook` で固定です。
- PEM は RSA 形式と PKCS#8 形式の両方に対応します。
- `wrangler.toml` はこのディレクトリ直下にあります。

## Workflow 側の前提

`repository_dispatch.yml` では次の secrets を使います。

- `CHECKER_APP_ID`
- `CHECKER_PRIVATE_KEY`

workflow は `repository_dispatch` と `pull_request` を処理します。
前者では payload から PR repository を特定します。
後者では、この repo に install 済みの checker App を使います。
Worker は self-webhook を落として二重起動を防ぎます。

### router workflow の流れ

1. changed files と linter 定義を評価する
2. 共通の in-progress check run を作る
3. `lint-common.yml` を linter 名ごとに並列実行する
4. 結果を PR comment と check run に集約する

### linter ごとの扱い

| linter | 設定ファイル / 挙動 |
|--------|---------------------|
| `actionlint` | `.github/actionlint.yaml` / `.yml` を自動で読みます。 |
| `ghalint` | `.ghalint.yaml` / `.ghalint.yml` / `ghalint.yaml` / `ghalint.yml` / `.github/ghalint.yaml` / `.github/ghalint.yml` を順に探します。 |
| `spectral` | `.spectral.yml` / `.spectral.yaml` / `.spectral.json` を読みます。未配置時は `spectral:oas` を使い、unknown format は無視します。 |
| `yamllint` | `.yamllint` 系 3 形式を順に探します。 |
| `biome` | Biome の既定探索で `biome.json` / `biome.jsonc` / `.biome.json` / `.biome.jsonc` を探し、未配置時は既定値を使います。 |
| `shellcheck` | `.shellcheckrc` / `shellcheckrc` を対象 script の場所から親へ向けて探します。 |
| `zizmor` | このリポジトリでは `zizmor.yml` / `zizmor.yaml` / `.github/zizmor.yml` / `.github/zizmor.yaml` を配置先として案内します。 |

- 実装本体は `.github/scripts/linters/*.sh` に分割しています。
- 詳細ログは抑え、結果は PR comment へ集約します。
- `.spectral.js` は任意コード実行を避けるため対象外です。

## `repository_dispatch` payload

Worker は `client_payload` を固定形式で送ります。
`pull_request` では head/base の詳細まで含めます。
`check_run` では PR 番号だけを最小で含めます。
不足する詳細は workflow 側で取り直します。

### `pull_request` event

```json
{
  "event_name": "pull_request",
  "action": "opened",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "repository": {
    "owner": { "login": "octo-org", "type": "Organization" },
    "name": "pr-repo",
    "full_name": "octo-org/pr-repo"
  },
  "pull_request": {
    "number": 42,
    "head": {
      "ref": "feature/example",
      "sha": "abc123",
      "repo": {
        "owner": { "login": "octocat", "type": "User" },
        "name": "forked-repo",
        "full_name": "octocat/forked-repo"
      }
    },
    "base": { "ref": "main", "sha": "def456" }
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
    "owner": { "login": "octo-org", "type": "Organization" },
    "name": "pr-repo",
    "full_name": "octo-org/pr-repo"
  },
  "pull_request": { "number": 42 },
  "check_run": {
    "name": "ci / test",
    "status": "completed",
    "conclusion": "success",
    "head_sha": "abc123"
  }
}
```

### payload の補足

- `repository` は PR が属する repository を表します。
- fork PR では `pull_request.head.repo` が source repository です。
- `check_run` では source repo への追加 API call を行いません。
- `linter-service:` で始まる check run は Worker が無視します。
- dispatch 先 repo 自身の webhook も Worker が無視します。

## 関連ファイル

| ファイル | 役割 |
|----------|------|
| `src/index.ts` | Worker 本体 |
| `test/index.test.ts` | Webhook 検証と dispatch 処理のテスト |
| `wrangler.toml` | Cloudflare Workers 設定 |
| `.dev.vars.example` | ローカル開発用の環境変数サンプル |
