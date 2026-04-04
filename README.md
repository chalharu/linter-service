# linter-service

このリポジトリは、複数 repository の PR と default branch push に対して、
共通の GitHub Actions で lint を実行するための基盤である。
GitHub App Webhook を Cloudflare Worker が受け、この repository へ
`repository_dispatch` を送る。

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

- 外部リポジトリの PR と default branch push は Worker 経由で処理する。
- このリポジトリ自身の PR は `pull_request`、default branch 更新は `push` で処理する。
- Worker は dispatch 先 repo からの self-webhook を無視し、二重実行と再帰起動を防ぐ。

## 主な場所

| パス | 役割 |
|------|------|
| `.github/workflows/repository-dispatch.yml` | router workflow |
| `.github/workflows/lint-common.yml` | 共通 reusable workflow |
| `.github/linter-service.json` | source repo 側の exclude / disable 設定 |
| `linters.json` | linter 定義と report/SARIF 文言 |
| `<linter>/` | linter ごとの script / fixture test / helper |
| `.github/scripts/` | shared helper / renderer / artifact utility |
| `.github/workflows/ci.yml` | `worker/` 検証と fixture test CI |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 共有 linter 一覧

- PR では changed file path から選択する。
- default branch push では tracked file path 全体から選択する。
- `.github/linter-service.json` がない場合は、`初期選択` 列で有効な linter を
   この file による除外パス設定なしで選択する。
- `textlint` のような `初期選択` 列で無効な linter と、`linters.json` の
   `required_root_files` に列挙した repo root 必須 file がそろわない linter は
   自動選択しない。
- 設定ファイルの変更時は、対応 linter の target file path 全体を再評価する。

| linter | 対象ファイル | 設定ファイル | 初期選択 |
| --- | --- | --- | --- |
| `actionlint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.github/actionlint.yaml`, `.github/actionlint.yml` | ✅ |
| `ghalint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | 左から順に `.ghalint.yaml`, `.ghalint.yml`, `ghalint.yaml`, `ghalint.yml`, `.github/ghalint.yaml`, `.github/ghalint.yml` | ✅ |
| `hadolint` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | 対象 file の親方向の `.hadolint.yaml`, `.hadolint.yml` | ✅ |
| `trivy` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | repo root の `trivy.yaml`, `trivy.yml`, `.trivyignore` | ✅ |
| `dotenv-linter` | `.env`, `.env.*` | なし | ✅ |
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml`, `.spectral.yaml`, `.spectral.json` | ✅ |
| `yamllint` | `*.yaml`, `*.yml` | 左から順に `.yamllint`, `.yamllint.yaml`, `.yamllint.yml` | ✅ |
| `yamlfmt` | `*.yaml`, `*.yml` | 左から順に `.yamlfmt`, `yamlfmt.yml`, `yamlfmt.yaml`, `.yamlfmt.yaml`, `.yamlfmt.yml` | ✅ |
| `markdownlint-cli2` | `*.md`, `*.markdown` | 左から順に `.markdownlint-cli2.jsonc`, `.markdownlint-cli2.yaml`, `.markdownlint.jsonc`, `.markdownlint.json`, `.markdownlint.yaml`, `.markdownlint.yml` | ✅ |
| `textlint` | `*.md`, `*.markdown`, `*.txt` | repo root の `.textlintrc` | ❌ |
| `ruff` | `*.py`, `*.pyi` | 同一 directory では左から順に `.ruff.toml`, `ruff.toml`, `pyproject.toml` の `[tool.ruff]` | ✅ |
| `rustfmt` | `*.rs` | `rustfmt.toml`, `.rustfmt.toml`, `rust-toolchain.toml`, `rust-toolchain` | ✅ |
| `cargo-clippy` | `*.rs` | `clippy.toml`, `.clippy.toml`, `rust-toolchain.toml`, `rust-toolchain` | ✅ |
| `cargo-deny` | `Cargo.toml`, `Cargo.lock`, `deny.toml`, `.cargo/config`, `.cargo/config.toml` | 対象 `Cargo.toml` の親方向の `deny.toml` | ✅ |
| `taplo` | `*.toml` | 左から順に `.taplo.toml`, `taplo.toml` | ✅ |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | `biome.json`, `biome.jsonc`, `.biome.json`, `.biome.jsonc` | ✅ |
| `editorconfig-checker` | upstream default exclude に含まれない file | 対象 file の親 directory ごとの `.editorconfig`, repo root の `.editorconfig-checker.json`, `.ecrc` | ✅ |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | 対象 script の親方向の `.shellcheckrc`, `shellcheckrc` | ✅ |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml`, `zizmor.yaml`, `.github/zizmor.yml`, `.github/zizmor.yaml` | ✅ |

### 共有 linter ごとの実行メモ

| linter | 実行メモ |
| --- | --- |
| `trivy` | Dockerfile, Containerfile misconfiguration scan 専用、SHA pin した official image での最小権限実行。 |
| `dotenv-linter` | changed `.env` file への upstream default checks 直接適用、`--schema` と ignore-checks 注入は未対応。 |
| `spectral` | `.spectral.js` 非対応、未配置時は `spectral:oas`、unknown format は無視。 |
| `yamlfmt` | repo root config の明示指定、未配置時は temp default config 利用。 |
| `markdownlint-cli2` | 静的 config のみ対応、`.cjs`, `.mjs` 非対応、`globs` 不使用。 |
| `textlint` | repo root の `.textlintrc` のみ対応、YAML, JS, comment 付き config は非対応、`disabled: false` と exact version 付き `preset_packages` 指定時のみ動作。 |
| `ruff` | `--force-exclude` 付与。 |
| `rustfmt` | selected Rust file path の直接 `rustfmt --check` 実行。 |
| `cargo-clippy` | 最寄り `Cargo.toml` 基準の package 単位実行、`.cargo/config*`, private registry, private git dependency は未対応。 |
| `cargo-deny` | 最寄り `Cargo.toml` 基準の package 単位実行、`.cargo/config*`, private registry, private git dependency は未対応。 |
| `taplo` | 未配置時の既定 `fmt --check`。 |
| `editorconfig-checker` | `PassedFiles` 制限、`NoColor` 強制。 |
| `zizmor` | `--offline` 実行。 |

## `.github/linter-service.json`

- 利用 repository 側の target selection 制御用である。
- この file がない場合は、`初期選択` 列で有効な linter を、この file による
   除外パス設定なしで処理対象にする。
- `初期選択` 列で無効な linter と、`linters.json` の `required_root_files` に
   列挙した repo root 必須 file がそろわない linter は自動選択しない。

```json
{
  "global": {
    "exclude_paths": [
      "**/generated/**"
    ]
  },
  "linters": {
    "yamllint": {
      "exclude_paths": [
        "docs/openapi/**"
      ]
    },
    "textlint": {
      "disabled": false,
      "preset_packages": [
        "textlint-rule-preset-ja-technical-writing@12.0.2"
      ]
    },
    "zizmor": {
      "disabled": true
    }
  }
}
```

| 項目 | スコープ | 内容 |
| --- | --- | --- |
| `global.exclude_paths` | 全 linter | repo-relative glob pattern。全 linter への適用。 |
| `linters.<name>.exclude_paths` | 個別 linter | repo-relative glob pattern。global exclude との併用。 |
| `linters.<name>.disabled` | 個別 linter | `true` で選択対象外。`false` で `初期選択` 列で無効な linter の明示有効化。 |
| `linters.textlint.preset_packages` | `textlint` | exact version 付き npm package spec の配列。`textlint` 有効化時の必須項目。 |

## 共有 linter の追加方法

- 追加先は root の `linters.json` と root 直下の `<name>/` directory である。`.github/scripts/` は shared script 専用である。
- 最低限の構成は `patterns.sh`, `install.sh`, `run.sh` である。shared helper が必要な場合のみ `common.sh` を追加する。
- 参考実装は `actionlint/` が最小構成、`cargo-clippy/` と `textlint/` が隔離実行や config 解決を含む例である。
- fixture は `tests/<case>/target/`, `result.json`, `sarif.json` の構成である。最低でも pass と fail の 2 系統を用意する。
- `linters.json` が comment 見出し、成功 / 失敗文言、fallback message の正本である。通常は workflow 個別修正不要である。
- untrusted PR でも安全に扱える実装を前提とし、任意コード実行につながる config は拒否または隔離実行で扱う。
- 変更後は `node .github/scripts/run-fixture-tests.js <name>` で fixture test を実行する。
- 変更面に応じて focused unit test と `shellcheck`、`markdownlint-cli2`、`git diff --check` など既存 validation を実行する。

```text
<name>/
  common.sh                    # optional
  patterns.sh
  install.sh
  run.sh
  tests/
    pass/
      target/
      result.json
      sarif.json
    fail/
      target/
      result.json
      sarif.json
  <name>.test.js               # optional
  render-linter-sarif.test.js  # optional
```
