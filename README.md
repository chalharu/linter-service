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

- 外部リポジトリの PR と default branch push は Worker 経由で処理します。
- このリポジトリ自身の PR は `pull_request`、default branch 更新は `push` で処理します。
- Worker は dispatch 先 repo からの self-webhook を無視し、二重実行と再帰起動を防ぎます。

## 主な場所

| パス | 役割 |
|------|------|
| `.github/workflows/repository-dispatch.yml` | router workflow |
| `.github/workflows/lint-common.yml` | 共通 reusable workflow |
| `linters.json` | linter 定義と report/SARIF 文言 |
| `<linter>/` | linter ごとの script / test / helper |
| `.github/scripts/` | shared helper / renderer / artifact utility |
| `.github/workflows/ci.yml` | `worker/` の型検査・lint・テスト |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 共有 linter 一覧

`repository-dispatch.yml` は PR では changed file path から、
default branch push では repository 全体の tracked file path から対象 linter を選びます。
一致した linter にだけ、対応する target file path を渡します。

| linter | 対象ファイル | 設定ファイル | 制限事項 |
|--------|--------------|--------------|----------|
| `actionlint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.github/actionlint.yaml` / `.github/actionlint.yml` | - |
| `ghalint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.ghalint.yaml` → `.ghalint.yml` → `ghalint.yaml` → `ghalint.yml` → `.github/ghalint.yaml` → `.github/ghalint.yml` | - |
| `hadolint` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | 対象ファイルの directory から親へ向けて `.hadolint.yaml` / `.hadolint.yml` を探し、見つかれば `--config` で明示します。 | 未配置時は既定値を使います。 |
| `dotenv-linter` | `.env`, `.env.*` | なし | shared workflow は upstream default checks を changed `.env` file に直接適用します。`--schema` や ignore-checks の注入は現状未対応です。 |
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml` / `.spectral.yaml` / `.spectral.json` | 未配置時は `spectral:oas` を使い、unknown format は無視します。`.spectral.js` は任意コード実行を避けるため対象外です。 |
| `yamllint` | `*.yaml`, `*.yml` | `.yamllint` → `.yamllint.yaml` → `.yamllint.yml` | - |
| `yamlfmt` | `*.yaml`, `*.yml` | `.yamlfmt` → `yamlfmt.yml` → `yamlfmt.yaml` → `.yamlfmt.yaml` → `.yamlfmt.yml` | shared workflow は repo root の静的 config を `-conf` で明示し、未配置時は temp default config で `-lint` を実行します。global config は使いません。 |
| `markdownlint-cli2` | `*.md`, `*.markdown` | `.markdownlint-cli2.jsonc` / `.markdownlint-cli2.yaml` / `.markdownlint.jsonc` / `.markdownlint.json` / `.markdownlint.yaml` / `.markdownlint.yml` | 静的 config のみを扱います。`.cjs` / `.mjs` は任意コード実行を避けるため対象外です。共有 workflow は `globs` を使わず、変更対象だけを検査します。 |
| `ruff` | `*.py`, `*.pyi` | 対象ファイルごとに近い `pyproject.toml` の `[tool.ruff]` / `ruff.toml` / `.ruff.toml` を使い、同一 directory では `.ruff.toml` → `ruff.toml` → `pyproject.toml` の順です。 | 共有 workflow は `--force-exclude` を付け、設定上の除外も尊重します。 |
| `rustfmt` | `*.rs` | `rustfmt.toml` / `.rustfmt.toml` と `rust-toolchain.toml` / `rust-toolchain` は rustfmt / rustup の既定探索を使います。 | shared workflow は selected Rust file path をそのまま `rustfmt --check` に渡します。`Cargo.toml` 探索や package / workspace 単位への変換は行いません。 |
| `cargo-clippy` | `*.rs` | `clippy.toml` / `.clippy.toml` と `rust-toolchain.toml` / `rust-toolchain` は tool の既定探索を使います。 | 変更された Rust ファイルごとに最も近い `Cargo.toml` を基準に、重複を除いた package 単位で `cargo fetch` の後に `cargo clippy --manifest-path ... --all-targets -- -D warnings` を実行します。Clippy 実行本体は `--network none` 付き Docker container へ隔離し、rustup state は writable mount へ seed してから使います。repository-supplied `.cargo/config` / `.cargo/config.toml` は共有 path では未対応です。private git dependency や認証が必要な registry は現状サポートしません。 |
| `cargo-deny` | `Cargo.toml`, `Cargo.lock`, `deny.toml`, `.cargo/config`, `.cargo/config.toml` | 対象 `Cargo.toml` の directory から親へ向けて `deny.toml` を探し、見つかれば `--config` で明示します。未配置時は cargo-deny の既定値を使います。 | 変更された dependency / policy file ごとに最も近い `Cargo.toml` を基準に、重複を除いた package 単位で `cargo-deny check` を実行します。shared workflow は `--all-features` と `--color never` を付けます。repository-supplied `.cargo/config` / `.cargo/config.toml` は共有 path では未対応です。private registry や認証が必要な git dependency は現状サポートしません。 |
| `taplo` | `*.toml` | `.taplo.toml` を優先し、なければ repo root の `taplo.toml` を使います。 | 未配置時は既定値で `fmt --check` を行います。 |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | Biome の既定探索で `biome.json` / `biome.jsonc` / `.biome.json` / `.biome.jsonc` を探します。 | 未配置時は既定値を使います。 |
| `editorconfig-checker` | ほぼ全ファイルのうち、upstream documented default exclude（lock / binary / generated asset など）に当たらない path | 対象ファイルの親 directory ごとの `.editorconfig` と、repo root の `.editorconfig-checker.json` / `.ecrc` を使います。 | 共有 workflow は changed file を `PassedFiles` で限定し、`NoColor` を強制します。repository-supplied `Version` pinning は共有 path では未対応です。 |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | 対象 script の場所から親へ向けて `.shellcheckrc` / `shellcheckrc` を探します。 | - |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml` / `zizmor.yaml` / `.github/zizmor.yml` / `.github/zizmor.yaml` | 共有 workflow は `--offline` で実行します。 |

## 共有 linter の追加方法

新しい共有 linter は、通常は workflow を増やさずに root の `linters.json` と
root 直下の `<name>/` directory を追加します。`.github/scripts/` には shared script だけを置きます。

1. root に `<name>/` directory を追加し、最低限 `patterns.sh`, `install.sh`,
   `run.sh` を置きます。共通実装をまとめたい場合は同じ directory に `main.sh`
   や `common.sh` を置いて構いません。`repository-dispatch.yml` は
   `<name>/patterns.sh` の regex で対象 linter を選び、`lint-common.yml` は
   一致した target file path を `<name>/run.sh` に渡します。

   ```text
   <name>/
     patterns.sh
     install.sh
     run.sh
     main.sh                  # optional
     common.sh                # optional
     <name>.test.js           # optional focused test
     render-linter-sarif.test.js
   ```

   現在の repository では `patterns.sh` / `install.sh` / `run.sh` を独立 entrypoint
   にしつつ、必要に応じて `main.sh` に委譲する構成を使っています。

   ```bash
   # patterns.sh
   #!/usr/bin/env bash
   set -euo pipefail
   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   exec bash "$script_dir/main.sh" patterns "$@"
   ```

   ```bash
   # main.sh
   #!/usr/bin/env bash

   set -euo pipefail

   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   # shellcheck source=../.github/scripts/linter-library.sh
   source "$script_dir/../.github/scripts/linter-library.sh"

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

2. `install.sh` は runner 既定 tool を再利用できるならそれを優先し、
   足りない場合だけ `$RUNNER_TEMP` 配下へ install して
   `linter_lib::add_path` で PATH に追加します。
   単純な例は `actionlint/main.sh` や `taplo/main.sh`、
   repository ごとの解決が必要な例は `cargo-clippy/main.sh` を参照してください。

3. `run.sh` は changed file path をそのまま tool に渡せるかを先に確認します。
   `rustfmt/run.sh` は selected Rust file をそのまま `rustfmt --check` に渡します。
   そのまま扱えない場合は wrapper 側で package / workspace / temp repo に
   変換します。`cargo-clippy/run.sh` は Cargo package ごとにまとめ、
   `markdownlint-cli2/run.sh` は temp repo を組み立てて changed file だけを検査します。

4. 利用 repository 側の config を読む linter や、
   compile / build によって repository code を実行する linter は、
   untrusted pull request でも安全に扱えることを確認してください。
   JavaScript のように任意コード実行につながる config は許可せず、
   静的 config のみを受けるか、wrapper で明示的に reject します。
   `markdownlint-cli2/main.sh` と `spectral/main.sh` は config 側の実例で、
   `cargo-clippy` は Docker container 実行と `.cargo/config*` reject の実例です。

5. root の `linters.json` に entry を追加します。
   ここが comment 見出し、成功 / 失敗文言、fallback message の source of truth です。
   通常は linter を増やすために `repository-dispatch.yml` や
   `lint-common.yml` を個別修正する必要はありません。

6. この `README.md` の「共有 linter 一覧」に、
   対象ファイル、設定ファイル、制限事項を 1 行追記します。

7. path 解決、config 探索、package grouping のような
   非自明な処理がある場合は `<name>/<name>.test.js` のような focused test を追加します。
   SARIF を出す linter は `<name>/render-linter-sarif.test.js` も更新し、
   shell script には `shellcheck -x -P SCRIPTDIR` を通してください。

8. 変更後は、触った面に応じて既存の validation を実行します。
   例:
   - `node --test <name>/<name>.test.js`
   - `node --test <name>/render-linter-sarif.test.js`
   - `shellcheck -x -P SCRIPTDIR <name>/*.sh`
   - `markdownlint-cli2 --no-globs README.md`
   - `git diff --check`

## 詳細

- Worker の設定と運用は `worker/README.md` を参照してください。
- 共有 linter の一覧、対象ファイル、設定ファイル、制限事項は上の表を参照してください。
- 共有 lint の入口は `repository-dispatch.yml` です。
- 実処理は `lint-common.yml` と shell script に集約しています。
