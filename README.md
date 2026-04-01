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
| `.github/workflows/lint-common.yml` | 共通 reusable workflow |
| `.github/scripts/linters/*.sh` | linter ごとの実装 |
| `.github/workflows/ci.yml` | `worker/` の型検査・lint・テスト |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 共有 linter 一覧

`repository-dispatch.yml` は changed file path から対象 linter を選びます。
一致した linter にだけ、対応する changed file を渡します。

| linter | 対象ファイル | 設定ファイル / 挙動 |
|--------|--------------|---------------------|
| `actionlint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.github/actionlint.yaml` / `.github/actionlint.yml` を自動で読みます。 |
| `ghalint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.ghalint.yaml` / `.ghalint.yml` / `ghalint.yaml` / `ghalint.yml` / `.github/ghalint.yaml` / `.github/ghalint.yml` を順に探します。 |
| `hadolint` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | 対象 file の directory から親へ向けて `.hadolint.yaml` / `.hadolint.yml` を探し、見つかれば `--config` で明示します。未配置時は hadolint の既定値を使います。 |
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml` / `.spectral.yaml` / `.spectral.json` を読みます。未配置時は `spectral:oas` を使い、unknown format は無視します。`.spectral.js` は任意コード実行を避けるため対象外です。 |
| `yamllint` | `*.yaml`, `*.yml` | `.yamllint` / `.yamllint.yaml` / `.yamllint.yml` を順に探します。 |
| `markdownlint-cli2` | `*.md`, `*.markdown` | `.markdownlint-cli2.jsonc` / `.markdownlint-cli2.yaml` と `.markdownlint.jsonc` / `.markdownlint.json` / `.markdownlint.yaml` / `.markdownlint.yml` の静的 config のみを扱います。`.cjs` / `.mjs` は任意コード実行を避けるため対象外です。共有 workflow は `globs` を使わず、変更対象だけを検査します。 |
| `ruff` | `*.py`, `*.pyi` | `pyproject.toml` の `[tool.ruff]`、`ruff.toml`、`.ruff.toml` を対象 file ごとに近いものから使います。同一 directory では `.ruff.toml` → `ruff.toml` → `pyproject.toml` の順です。共有 workflow は `--force-exclude` を付け、設定上の除外も尊重します。 |
| `cargo-fmt` | `*.rs` | changed Rust file ごとに最も近い `Cargo.toml` を探し、重複を除いた package 単位で `cargo fmt --check --manifest-path ...` を実行します。`rustfmt.toml` / `.rustfmt.toml` と `rust-toolchain.toml` / `rust-toolchain` は Cargo / rustup の既定探索を使います。 |
| `cargo-clippy` | `*.rs` | changed Rust file ごとに最も近い `Cargo.toml` を探し、重複を除いた package 単位で `cargo fetch` の後に `cargo clippy --manifest-path ... --all-targets -- -D warnings` を実行します。Clippy 実行本体は `--network none` 付き Docker container へ隔離し、source checkout は host 側から直接 build させません。repository-supplied `.cargo/config` / `.cargo/config.toml` は共有 path では未対応です。private git dependency や認証が必要な registry は現状サポートしません。 |
| `taplo` | `*.toml` | `.taplo.toml` を優先し、なければ `taplo.toml` を repo root で探します。未配置時は既定値で `fmt --check` を行います。 |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | Biome の既定探索で `biome.json` / `biome.jsonc` / `.biome.json` / `.biome.jsonc` を探し、未配置時は既定値を使います。 |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | `.shellcheckrc` / `shellcheckrc` を対象 script の場所から親へ向けて探します。 |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml` / `zizmor.yaml` / `.github/zizmor.yml` / `.github/zizmor.yaml` を配置先として案内します。 |

## 共有 linter の追加方法

新しい共有 linter は、通常は workflow を追加せずに data-driven な定義だけを足します。
基本的には `.github/scripts/linters/` と `.github/scripts/linters/config.json` と
この `README.md` を更新すれば済みます。

1. `.github/scripts/linters/<name>.sh` を追加します。
   `patterns`, `install`, `run` の 3 mode を実装してください。
   `repository-dispatch.yml` は `patterns` の regex で対象 linter を選び、
   `lint-common.yml` は一致した changed file path を `run` に渡します。

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail

   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   # shellcheck source=../linter-library.sh
   source "$script_dir/../linter-library.sh"

   mode=${1-}
   if [ "$#" -gt 0 ]; then
     shift
   fi

   case "$mode" in
     patterns)
       cat <<'EOF'
   \.(?:ext)$
   EOF
       ;;
     install)
       : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
       # tool install
       ;;
     run)
       : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
       output_file="$RUNNER_TEMP/linter-output.txt"
       linter_lib::run_and_emit_json "$output_file" your-linter "$@"
       ;;
     *)
       echo "usage: $0 {patterns|install|run}" >&2
       exit 1
       ;;
   esac
   ```

2. `install` は runner 既定 tool を再利用できるならそれを優先し、
   足りない場合だけ `$RUNNER_TEMP` 配下へ install して
   `linter_lib::add_path` で PATH に追加します。
   単純な例は `actionlint.sh` や `taplo.sh`、
   repository ごとの解決が必要な例は `cargo-fmt.sh` を参照してください。

3. `run` は changed file path をそのまま tool に渡せるかを先に確認します。
   そのまま扱えない場合は wrapper 側で package / workspace / temp repo に
   変換します。`cargo-fmt.sh` は Cargo package 単位へまとめ、
   `markdownlint-cli2.sh` は temp repo を組み立てて changed file だけを検査します。

4. 利用 repository 側の config を読む linter や、
   compile / build によって repository code を実行する linter は、
   untrusted pull request でも安全に扱えることを確認してください。
   JavaScript のように任意コード実行につながる config は許可せず、
   静的 config のみを受けるか、wrapper で明示的に reject します。
   `markdownlint-cli2.sh` と `spectral.sh` は config 側の実例で、
   `cargo-clippy` は Docker container 実行と `.cargo/config*` reject の実例です。

5. `.github/scripts/linters/config.json` に entry を追加します。
   ここが comment 見出し、成功 / 失敗文言、fallback message の source of truth です。
   通常は linter を増やすために `repository-dispatch.yml` や
   `lint-common.yml` を個別修正する必要はありません。

6. この `README.md` の「共有 linter 一覧」に、
   対象ファイルと config 探索 / 挙動を 1 行追記します。

7. wrapper に path 解決、config 探索、package grouping のような
   非自明な処理がある場合は、
   `.github/scripts/linters/<name>.test.js` のような focused test を追加します。
   単純な wrapper でも `shellcheck -x -P SCRIPTDIR` は通してください。

8. 変更後は、触った面に応じて既存の validation を実行します。
   例:
   - `node --test .github/scripts/linters/<name>.test.js`
   - `shellcheck -x -P SCRIPTDIR .github/scripts/linters/<name>.sh`
   - `markdownlint-cli2 --no-globs :README.md`
   - `git diff --check`

## 詳細

- Worker の設定と運用は `worker/README.md` を参照してください。
- 共有 linter の一覧、対象ファイル、設定ファイル / 挙動は上の表を参照してください。
- 共有 lint の入口は `repository-dispatch.yml` です。
- 実処理は `lint-common.yml` と shell script に集約しています。
