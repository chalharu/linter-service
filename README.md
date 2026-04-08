# linter-service

このリポジトリは、複数 repository の PR と default branch push に対して、
共通の GitHub Actions で lint を実行するための基盤です。
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
- Worker は `repository_dispatch.client_payload` に HMAC 署名を付け、workflow 側は GitHub App token を発行する前に署名を検証する。

## 主な場所

| パス | 役割 |
|------|------|
| `.github/codeql/` | CodeQL の分析設定 |
| `.github/linter-service.yaml`, `.github/linter-service.yml` | source repo 側の exclude / disable 設定 |
| `.github/linter-service.schema.json` | `.github/linter-service.yaml`, `.github/linter-service.yml` の editor validation / 補完用 schema |
| `.github/scripts/` | shared helper / renderer / artifact utility |
| `.github/workflows/ci.yml` | `worker/` 検証と fixture test CI |
| `.github/workflows/codeql.yml` | fixture 除外付き CodeQL workflow |
| `.github/workflows/lint-common.yml` | 共通 reusable workflow |
| `.github/workflows/repository-dispatch.yml` | router workflow |
| `<linter>/` | linter ごとの script / fixture test / helper |
| `linters.json` | linter 定義 object と SARIF / 実行メタデータ |
| `linters.schema.json` | `linters.json` の editor validation / 補完用 schema |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 共有 linter 一覧

- PR では changed file path から選択する。
- default branch push では tracked file path 全体から選択する。
- `.github/linter-service.yaml`, `.github/linter-service.yml` を優先して読み込み、
  互換のため `.github/linter-service.json` も fallback で読み込む。
- どちらの file もない場合は、`初期選択` 列で有効な linter を
  この file による除外パス設定なしで選択する。
- `linters.json` の `required_root_files` に列挙した repo root 必須 file が
  そろわない linter と、追加 runtime config が足りない linter は自動選択しない。
- `textlint` は repo root の `.textlintrc` と
  `linters.textlint.preset_packages` の両方がそろった場合だけ自動選択する。
- 設定ファイルの変更時は、対応 linter の target file path 全体を再評価する。
- 設定ファイル変更の再評価条件は、各 linter directory の
  `config_trigger_patterns.sh` が正本である。

| linter | 対象ファイル | 設定ファイル | 初期選択 |
| --- | --- | --- | --- |
| `actionlint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.github/actionlint.yaml`, `.github/actionlint.yml` | ✅ |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | `biome.json`, `biome.jsonc`, `.biome.json`, `.biome.jsonc` | ✅ |
| `cargo-clippy` | `*.rs` | `clippy.toml`, `.clippy.toml`, `rust-toolchain.toml`, `rust-toolchain` | ✅ |
| `cargo-deny` | `Cargo.toml`, `Cargo.lock`, `deny.toml`, `.cargo/config`, `.cargo/config.toml` | 対象 `Cargo.toml` の親方向の `deny.toml` | ✅ |
| `dotenv-linter` | `.env`, `.env.*` | なし | ✅ |
| `editorconfig-checker` | upstream default exclude に含まれない file | 対象 file の親 directory ごとの `.editorconfig`, repo root の `.editorconfig-checker.json`, `.ecrc` | ✅ |
| `ghalint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | 左から順に `.ghalint.yaml`, `.ghalint.yml`, `ghalint.yaml`, `ghalint.yml`, `.github/ghalint.yaml`, `.github/ghalint.yml` | ✅ |
| `hadolint` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | 対象 file の親方向の `.hadolint.yaml`, `.hadolint.yml` | ✅ |
| `helmlint` | `Chart.yaml`, `Chart.lock`, `values*.yaml`, `values*.yml`, `values.schema.json`, `templates/**`, `crds/**`, `charts/**` | なし | ✅ |
| `lizard` | `linters.lizard.languages` で選んだ言語に対応する source file | `.github/linter-service.yaml`, `.github/linter-service.yml`, `.github/linter-service.json`, repo root の `whitelizard.txt` | ❌ |
| `markdownlint-cli2` | `*.md`, `*.markdown` | 左から順に `.markdownlint-cli2.jsonc`, `.markdownlint-cli2.yaml`, `.markdownlint.jsonc`, `.markdownlint.json`, `.markdownlint.yaml`, `.markdownlint.yml` | ✅ |
| `ruff` | `*.py`, `*.pyi` | 同一 directory では左から順に `.ruff.toml`, `ruff.toml`, `pyproject.toml` の `[tool.ruff]` | ✅ |
| `rustfmt` | `*.rs` | `rustfmt.toml`, `.rustfmt.toml`, `rust-toolchain.toml`, `rust-toolchain` | ✅ |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | 対象 script の親方向の `.shellcheckrc`, `shellcheckrc` | ✅ |
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml`, `.spectral.yaml`, `.spectral.json` | ✅ |
| `taplo` | `*.toml` | 左から順に `.taplo.toml`, `taplo.toml` | ✅ |
| `textlint` | `*.md`, `*.markdown`, `*.txt` | repo root の `.textlintrc` | ✅ |
| `trivy` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | repo root の `trivy.yaml`, `trivy.yml`, `.trivyignore` | ✅ |
| `yamlfmt` | `*.yaml`, `*.yml` | 左から順に `.yamlfmt`, `yamlfmt.yml`, `yamlfmt.yaml`, `.yamlfmt.yaml`, `.yamlfmt.yml` | ✅ |
| `yamllint` | `*.yaml`, `*.yml` | 左から順に `.yamllint`, `.yamllint.yaml`, `.yamllint.yml` | ✅ |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml`, `zizmor.yaml`, `.github/zizmor.yml`, `.github/zizmor.yaml` | ✅ |

### 共有 linter ごとの実行メモ

| linter | 実行メモ |
| --- | --- |
| `cargo-clippy` | 最寄り `Cargo.toml` 基準の package 単位実行、`.cargo/config*`, private registry, private git dependency は未対応。 |
| `cargo-deny` | 最寄り `Cargo.toml` 基準の package 単位実行、`.cargo/config*`, private registry, private git dependency は未対応。 |
| `dotenv-linter` | changed `.env` file への upstream default checks 直接適用、`--schema` と ignore-checks 注入は未対応。 |
| `editorconfig-checker` | `PassedFiles` 制限、`NoColor` 強制。 |
| `helmlint` | changed file から親方向の `Chart.yaml` を解決し、chart directory ごとに重複排除して `helm lint` 実行。 |
| `lizard` | default disabled。repo 側の `linters.lizard.languages` で選んだ言語だけを対象にし、repo root の `whitelizard.txt` をそのまま利用する。 |
| `markdownlint-cli2` | 静的 config のみ対応、`.cjs`, `.mjs` 非対応、`globs` 不使用。 |
| `ruff` | `--force-exclude` 付与。 |
| `rustfmt` | selected Rust file path の直接 `rustfmt --check` 実行。 |
| `spectral` | `.spectral.js` 非対応、未配置時は `spectral:oas`、unknown format は無視。 |
| `taplo` | 未配置時の既定 `fmt --check`。 |
| `textlint` | repo root の `.textlintrc` のみ対応、YAML, JS, comment 付き config は非対応、exact version 付き `preset_packages` がある場合だけ自動選択する。 |
| `trivy` | Dockerfile, Containerfile misconfiguration scan 専用、SHA pin した official image での最小権限実行。 |
| `yamlfmt` | repo root config の明示指定、未配置時は temp default config 利用。 |
| `zizmor` | `--offline` 実行。 |

## `.github/linter-service.yaml`

- 利用 repository 側の target selection 制御用である。
- `.github/linter-service.yaml` を推奨し、`.github/linter-service.yml` も読める。
  互換のため `.github/linter-service.json` も読み込む。
- この repository 内の sample `.github/linter-service.yaml` は
  `# yaml-language-server: $schema=./linter-service.schema.json` で
  local schema を参照する。利用側で同じ comment を使う場合は
  `.github/linter-service.schema.json` も合わせて配置する。
- どちらの file もない場合は、`初期選択` 列で有効な linter を、
  この file による除外パス設定なしで処理対象にする。
- `linters.json` の `required_root_files` に列挙した repo root 必須 file と、
  linter ごとの追加 runtime config がそろわない場合は自動選択しない。

```yaml
global:
  exclude_paths:
    - "**/generated/**"
linters:
  yamllint:
    exclude_paths:
      - "docs/openapi/**"
  lizard:
    disabled: false
    languages:
      - javascript
      - typescript
  textlint:
    preset_packages:
      - "textlint-rule-preset-ja-technical-writing@12.0.2"
  zizmor:
    disabled: true
```

| 項目 | スコープ | 内容 |
| --- | --- | --- |
| `global.exclude_paths` | 全 linter | repo-relative glob pattern。全 linter への適用。 |
| `linters.<name>.disabled` | 個別 linter | `true` で選択対象外。`false` は明示的な無効化解除として扱う。 |
| `linters.<name>.exclude_paths` | 個別 linter | repo-relative glob pattern。global exclude との併用。 |
| `linters.lizard.languages` | `lizard` | `lizard` opt-in 時の対象言語一覧。`disabled: false` と併用する。 |
| `linters.textlint.preset_packages` | `textlint` | exact version 付き npm package spec の配列。`.textlintrc` と併せて `textlint` 自動選択時の必須項目。 |

- `lizard` は `default_disabled` であるため、`linters.lizard.disabled: false` を明示した場合だけ選択対象になる。
- `linters.lizard.languages` で指定できる値は `cpp`, `csharp`, `erlang`, `fortran`, `gdscript`, `go`, `java`, `javascript`, `kotlin`, `lua`, `objectivec`, `perl`, `php`, `plsql`, `python`, `r`, `ruby`, `rust`, `scala`, `solidity`, `st`, `swift`, `ttcn`, `typescript`, `vue`, `zig` である。

## 共有 linter の追加方法

- 追加先は root の `linters.json` と root 直下の `<name>/` directory である。`.github/scripts/` は shared script 専用である。
- `linters.json` は `linters.<name>` を key に持つ object である。editor validation が必要な場合だけ root の `linters.schema.json` を `$schema` で参照する。schema と実データは同時に更新する。
- 最低限の構成は `patterns.sh`, `install.sh`, `run.sh` である。設定ファイル変更で全 target を再評価する linter だけ `config_trigger_patterns.sh` を追加する。shared helper が必要な場合のみ `common.sh` を追加する。
- `linters.json` で `isolated: true` を付けた linter は shared batch から分離し、専用 job で実行する。
- 参考実装は `actionlint/` が最小構成、`cargo-clippy/` と `textlint/` が隔離実行や config 解決を含む例である。
- fixture は `tests/<case>/target/`, `result.json`, `sarif.json` の構成である。最低でも pass と fail の 2 系統を用意する。
- report 文言は shared renderer が checked target 数から動的生成する。`linters.json` は static 文言ではなく、選択条件・実行条件・SARIF 設定だけを持つ。
- untrusted PR でも安全に扱える実装を前提とし、任意コード実行につながる config は拒否または隔離実行で扱う。
- 変更後は `node .github/scripts/run-fixture-tests.js <name>` で fixture test を実行する。
- shared Node script の dependency を追加・更新した場合は、repo root で `npm ci` を実行する。
- 変更面に応じて focused unit test と `shellcheck`、`markdownlint-cli2`、`git diff --check` など既存 validation を実行する。

```text
<name>/
  common.sh                    # optional
  config_trigger_patterns.sh   # optional
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
