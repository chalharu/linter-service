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

外部リポジトリの PR と default branch push は Worker 経由で流れます。
このリポジトリ自身の PR は `pull_request`、default branch 更新は `push` で流れます。
Worker は dispatch 先 repo からの self-webhook を無視します。
これで二重実行と再帰起動を防ぎます。

## GitHub Apps

| App | Install 先 | 主な用途 |
|-----|------------|----------|
| `linter-service-dispatcher` | このリポジトリ | Worker から `repository_dispatch` を送る |
| `linter-service-checker` | 各利用リポジトリ + このリポジトリ | PR 情報取得、checkout、comment、check run 更新 |

- `dispatcher` の権限: `Contents: write`, `Metadata: read`
- `checker` の権限: `Checks: write`, `Contents: read`, `Pull requests: write`, `Metadata: read`
- `checker` の webhook は `Pull request`、`Push`、`Check run` を受けます。

Worker は重複しやすい webhook をそのまま全部転送せず、
shared lint 実行の authoritative な trigger だけを `repository_dispatch` へ流します。

- `pull_request`: `opened`, `reopened`, `synchronize`, `ready_for_review`
- `pull_request.edited`: base branch が変わったときだけ forward
- `push`: default branch への push だけを forward
- `check_run`: 受信はするが forward しない

Worker は checker App の secret で署名を見ます。
dispatch の送信は dispatcher App token で行います。
PR 向けの queued check run 作成は checker App token で行います。
workflow の更新も checker App token で行います。
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
wrangler secret put GITHUB_CHECKER_APP_ID
wrangler secret put GITHUB_CHECKER_APP_PRIVATE_KEY
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
| `GITHUB_CHECKER_APP_ID` | ✅ | checker App の ID |
| `GITHUB_CHECKER_APP_PRIVATE_KEY` | ✅ | checker App の PEM 秘密鍵 |
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

workflow は `repository_dispatch`、`pull_request`、`push` を処理します。
`repository_dispatch` では payload から source repository を特定します。
direct trigger では、この repo に install 済みの checker App を使います。
Worker は dispatch 先 repo からの self-webhook を無視し、二重実行と再帰起動を防ぎます。

### router workflow の流れ

1. PR では changed files、default branch push では repository 全体の tracked files と linter 定義を評価する
2. Worker が PR 向けの queued check run を速やかに作る
3. workflow が同じ check run を in-progress へ更新する
4. `lint-common.yml` を linter 名ごとに並列実行する
5. 結果を PR では comment / check run / SARIF、default branch push では check run / SARIF に集約する

### 共有 linter 一覧の参照先

- 共有 linter の一覧、対象ファイル、設定ファイル、制限事項は repo root の
  `README.md` を参照してください。
- `worker/README.md` は Worker の webhook 受信、payload、routing、deploy
  手順に絞って記載します。

## `repository_dispatch` payload

Worker は `pull_request` と default-branch `push` を
`repository_dispatch.client_payload` に固定形式で送ります。
workflow 側は不足する詳細だけを取り直します。

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

### `push` event

```json
{
  "event_name": "push",
  "delivery_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "source_installation_id": 12345,
  "repository": {
    "owner": { "login": "octo-org", "type": "Organization" },
    "name": "service-repo",
    "full_name": "octo-org/service-repo",
    "default_branch": "main"
  },
  "push": {
    "ref": "refs/heads/main",
    "ref_name": "main",
    "before": "def456",
    "after": "abc123"
  }
}
```

### `check_run` event

`check_run` webhook も受信しますが、`repository_dispatch` には転送しません。
lint 対象の決定は PR 状態で十分に行えるため、各 upstream check completion をそのまま
forward すると同じ PR/head SHA に対して重複 run が増えるためです。

### payload の補足

- `repository` は PR が属する repository を表します。
- fork PR では `pull_request.head.repo` が source repository です。
- `pull_request` は lint 対象が変わり得る action だけを forward します。
- `pull_request.edited` は base branch 変更時だけを forward します。
- `push` は default branch への更新だけを forward し、その後の lint は repository 全体を対象にします。
- `check_run` は loop prevention と明示的な skip/error 応答のために受信しますが、forward しません。
- `linter-service:` で始まる check run は Worker が無視します。
- dispatch 先 repo 自身の webhook も Worker が無視します。

## 関連ファイル

| ファイル | 役割 |
|----------|------|
| `src/index.ts` | Worker 本体 |
| `test/index.test.ts` | Webhook 検証と dispatch 処理のテスト |
| `wrangler.toml` | Cloudflare Workers 設定 |
| `.dev.vars.example` | ローカル開発用の環境変数サンプル |
