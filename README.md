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
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml` / `.spectral.yaml` / `.spectral.json` を読みます。未配置時は `spectral:oas` を使い、unknown format は無視します。`.spectral.js` は任意コード実行を避けるため対象外です。 |
| `yamllint` | `*.yaml`, `*.yml` | `.yamllint` / `.yamllint.yaml` / `.yamllint.yml` を順に探します。 |
| `markdownlint-cli2` | `*.md`, `*.markdown` | `.markdownlint-cli2.jsonc` / `.markdownlint-cli2.yaml` と `.markdownlint.jsonc` / `.markdownlint.json` / `.markdownlint.yaml` / `.markdownlint.yml` の静的 config のみを扱います。`.cjs` / `.mjs` は任意コード実行を避けるため対象外です。共有 workflow は `globs` を使わず、変更対象だけを検査します。 |
| `ruff` | `*.py`, `*.pyi` | `pyproject.toml` の `[tool.ruff]`、`ruff.toml`、`.ruff.toml` を対象 file ごとに近いものから使います。同一 directory では `.ruff.toml` → `ruff.toml` → `pyproject.toml` の順です。共有 workflow は `--force-exclude` を付け、設定上の除外も尊重します。 |
| `cargo-fmt` | `*.rs` | changed Rust file ごとに最も近い `Cargo.toml` を探し、重複を除いた package 単位で `cargo fmt --check --manifest-path ...` を実行します。`rustfmt.toml` / `.rustfmt.toml` と `rust-toolchain.toml` / `rust-toolchain` は Cargo / rustup の既定探索を使います。 |
| `taplo` | `*.toml` | `.taplo.toml` を優先し、なければ `taplo.toml` を repo root で探します。未配置時は既定値で `fmt --check` を行います。 |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | Biome の既定探索で `biome.json` / `biome.jsonc` / `.biome.json` / `.biome.jsonc` を探し、未配置時は既定値を使います。 |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | `.shellcheckrc` / `shellcheckrc` を対象 script の場所から親へ向けて探します。 |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml` / `zizmor.yaml` / `.github/zizmor.yml` / `.github/zizmor.yaml` を配置先として案内します。 |

## 詳細

- Worker の設定と運用は `worker/README.md` を参照してください。
- 共有 linter の一覧、対象ファイル、設定ファイル / 挙動は上の表を参照してください。
- 共有 lint の入口は `repository-dispatch.yml` です。
- 実処理は `lint-common.yml` と shell script に集約しています。
