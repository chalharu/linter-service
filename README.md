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
| `.github/linter-service.json` | source repo 側の exclude / disable 設定 |
| `linters.json` | linter 定義と report/SARIF 文言 |
| `<linter>/` | linter ごとの script / fixture test / helper |
| `.github/scripts/` | shared helper / renderer / artifact utility |
| `.github/workflows/ci.yml` | `worker/` 検証と fixture test CI |
| `worker/` | Webhook を受ける Cloudflare Worker |

## 共有 linter 一覧

`repository-dispatch.yml` は PR では changed file path から、
default branch push では repository 全体の tracked file path から対象 linter を選びます。
`.github/linter-service.json` がない場合は、既定で有効な linter を exclude なしで
選択します。`textlint` のような default-disabled linter は明示的に有効化されるまで
選択されず、`required_root_files` を満たさない linter も対象外です。
表の設定 file path も linter selection に使われ、PR で設定 file だけが変わった場合は
その linter に対応する repository 全体の target file path を再評価します。

| linter | 対象ファイル | 設定ファイル | 既定 |
| --- | --- | --- | --- |
| `actionlint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.github/actionlint.yaml` / `.github/actionlint.yml` | 有効 |
| `ghalint` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `.ghalint.yaml` → `.ghalint.yml` → `ghalint.yaml` → `ghalint.yml` → `.github/ghalint.yaml` → `.github/ghalint.yml` | 有効 |
| `hadolint` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | 対象 file の親方向にある `.hadolint.yaml` / `.hadolint.yml` | 有効 |
| `trivy` | `Dockerfile`, `Dockerfile.*`, `Containerfile`, `Containerfile.*`, `*.dockerfile`, `*.containerfile` | repo root の `trivy.yaml` / `trivy.yml` と `.trivyignore` | 有効 |
| `dotenv-linter` | `.env`, `.env.*` | なし | 有効 |
| `spectral` | `*.json`, `*.yaml`, `*.yml` | `.spectral.yml` / `.spectral.yaml` / `.spectral.json` | 有効 |
| `yamllint` | `*.yaml`, `*.yml` | `.yamllint` → `.yamllint.yaml` → `.yamllint.yml` | 有効 |
| `yamlfmt` | `*.yaml`, `*.yml` | `.yamlfmt` → `yamlfmt.yml` → `yamlfmt.yaml` → `.yamlfmt.yaml` → `.yamlfmt.yml` | 有効 |
| `markdownlint-cli2` | `*.md`, `*.markdown` | `.markdownlint-cli2.jsonc` / `.markdownlint-cli2.yaml` / `.markdownlint.jsonc` / `.markdownlint.json` / `.markdownlint.yaml` / `.markdownlint.yml` | 有効 |
| `textlint` | `*.md`, `*.markdown`, `*.txt` | repo root の static JSON `.textlintrc` | 無効 |
| `ruff` | `*.py`, `*.pyi` | `pyproject.toml` の `[tool.ruff]` / `ruff.toml` / `.ruff.toml` | 有効 |
| `rustfmt` | `*.rs` | `rustfmt.toml` / `.rustfmt.toml` / `rust-toolchain.toml` / `rust-toolchain` | 有効 |
| `cargo-clippy` | `*.rs` | `clippy.toml` / `.clippy.toml` / `rust-toolchain.toml` / `rust-toolchain` | 有効 |
| `cargo-deny` | `Cargo.toml`, `Cargo.lock`, `deny.toml`, `.cargo/config`, `.cargo/config.toml` | 対象 `Cargo.toml` の親方向にある `deny.toml` | 有効 |
| `taplo` | `*.toml` | `.taplo.toml` → `taplo.toml` | 有効 |
| `biome` | `*.js`, `*.jsx`, `*.ts`, `*.tsx`, `*.json`, `*.jsonc`, `*.cjs`, `*.cts`, `*.mjs`, `*.mts` | `biome.json` / `biome.jsonc` / `.biome.json` / `.biome.jsonc` | 有効 |
| `editorconfig-checker` | ほぼ全 file（upstream default exclude を除く） | 対象 file の親 directory ごとの `.editorconfig` と repo root の `.editorconfig-checker.json` / `.ecrc` | 有効 |
| `shellcheck` | `*.bash`, `*.ksh`, `*.sh` | 対象 script の親方向にある `.shellcheckrc` / `shellcheckrc` | 有効 |
| `zizmor` | `.github/workflows/*.yml`, `.github/workflows/*.yaml` | `zizmor.yml` / `zizmor.yaml` / `.github/zizmor.yml` / `.github/zizmor.yaml` | 有効 |

### 共有 linter ごとの実行メモ

| linter | 実行メモ |
| --- | --- |
| `trivy` | Dockerfile/Containerfile の misconfiguration scan だけを、SHA pin した official image 内で最小権限実行します。 |
| `dotenv-linter` | upstream default checks を changed `.env` file に直接適用します。`--schema` と ignore-checks の注入は未対応です。 |
| `spectral` | `.spectral.js` は任意コード実行を避けるため対象外です。未配置時は `spectral:oas` を使い、unknown format は無視します。 |
| `yamlfmt` | repo root の静的 config を `-conf` で明示し、未配置時は temp default config で `-lint` を実行します。 |
| `markdownlint-cli2` | 静的 config だけを扱い、`.cjs` / `.mjs` は対象外です。`globs` は使わず changed file だけを検査します。 |
| `textlint` | repo root の static JSON `.textlintrc` だけを扱います。`.github/linter-service.json` で `disabled: false` と exact version 付き `preset_packages` を指定した時だけ動作します。 |
| `ruff` | `--force-exclude` を付け、設定上の除外も尊重します。 |
| `rustfmt` | selected Rust file path をそのまま `rustfmt --check` に渡します。`Cargo.toml` 探索や package / workspace 単位への変換は行いません。 |
| `cargo-clippy` | 最も近い `Cargo.toml` を基準に package 単位で `cargo fetch` の後に `cargo clippy` を実行します。repository-supplied `.cargo/config*` や private registry / git dependency は未対応です。 |
| `cargo-deny` | 最も近い `Cargo.toml` を基準に package 単位で `cargo-deny check` を実行します。repository-supplied `.cargo/config*` や private registry / git dependency は未対応です。 |
| `taplo` | 未配置時は既定値で `fmt --check` を行います。 |
| `editorconfig-checker` | changed file を `PassedFiles` で限定し、`NoColor` を強制します。 |
| `zizmor` | `--offline` を付けて実行します。 |

## `.github/linter-service.json`

利用 repository 側で `.github/linter-service.json` を置くと、shared workflow の
target selection を制御できます。file がない場合は、既定で有効な linter に対して
exclude なしで routing します。default-disabled な linter や `required_root_files`
を満たさない linter は、この状態では選択されません。

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
| `global.exclude_paths` | 全 linter | repo-relative glob pattern です。全 linter に適用されます。 |
| `linters.<name>.exclude_paths` | 個別 linter | repo-relative glob pattern です。global exclude と併用されます。 |
| `linters.<name>.disabled` | 個別 linter | `true` で selection 対象から外れます。`false` は default-disabled linter を明示的に有効化する時に使います。 |
| `linters.textlint.preset_packages` | `textlint` | exact version 付き npm package spec を 1 件以上指定します。`textlint` を有効化した時は必須です。 |
| `linters.textlint.preset_package` | `textlint` | backward compatibility 用の単数指定です。新規設定では `preset_packages` を推奨します。 |
| `textlint` の config | `textlint` | security のため repo root の static JSON `.textlintrc` だけを扱います。preset package は safe copy の `.textlintrc` に注入され、`.textlintrc` 側では rule key で preset option を調整できます。 |
| `textlint` の install | `textlint` | `ignore-scripts` と `min-release-age=3` を付け、preset 実行は isolated container 内で行います。 |
| この repository 自身の既定設定 | この repo | fixture 群を通常 lint から外すため、root の `.github/linter-service.json` で `**/tests/*/target/**` と `**/tests/*/sarif.json` を exclude し、`result.json` は lint 対象のままにしています。 |

## 共有 linter の追加方法

新しい共有 linter は、通常は workflow を増やさずに root の `linters.json` と
root 直下の `<name>/` directory を追加します。`.github/scripts/` には shared script だけを置きます。

1. root に `<name>/` directory を追加し、最低限 `patterns.sh`, `install.sh`,
   `run.sh` を置きます。共通 helper が必要なら同じ directory に `common.sh`
   を置いて構いません。`repository-dispatch.yml` は
   `<name>/patterns.sh` の regex で対象 linter を選び、`lint-common.yml` は
   一致した target file path を `<name>/run.sh` に渡します。

   ```text
    <name>/
      common.sh                # optional shared helpers
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
      <name>.test.js           # optional focused unit/integration test
      render-linter-sarif.test.js
    ```

   現在の repository では mode ごとの実装を `patterns.sh` / `install.sh` / `run.sh`
   に分け、共有 helper だけを `common.sh` に置いています。fixture test は
   `tests/[test-name]/target/` を temp repository として初期化して実行し、
   実結果を `result.json` / `sarif.json` と比較します。

   ```bash
   # common.sh
   #!/usr/bin/env bash

   set -euo pipefail

   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   # shellcheck source=../.github/scripts/linter-library.sh
   source "$script_dir/../.github/scripts/linter-library.sh"
   ```

   ```bash
   # patterns.sh
   #!/usr/bin/env bash
   set -euo pipefail

   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   # shellcheck source=./common.sh
   source "$script_dir/common.sh"

   cat <<'EOF'
   \.(?:ext)$
   EOF
   ```

   ```bash
   # run.sh
   #!/usr/bin/env bash
   set -euo pipefail

   script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
   # shellcheck source=./common.sh
   source "$script_dir/common.sh"

   : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
   output_file="$RUNNER_TEMP/linter-output.txt"
   linter_lib::run_and_emit_json "$output_file" your-linter "$@"
   ```

2. `install.sh` は runner 既定 tool を再利用できるならそれを優先し、
   足りない場合だけ `$RUNNER_TEMP` 配下へ install して
   `linter_lib::add_path` で PATH に追加します。
   単純な例は `actionlint/install.sh` や `taplo/install.sh`、
   repository ごとの解決が必要な例は `cargo-clippy/install.sh` を参照してください。

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
   `markdownlint-cli2/common.sh` と `spectral/common.sh` は config 側の実例で、
   `cargo-clippy` は Docker container 実行と `.cargo/config*` reject の実例です。

5. root の `linters.json` に entry を追加します。
   ここが comment 見出し、成功 / 失敗文言、fallback message の source of truth です。
   通常は linter を増やすために `repository-dispatch.yml` や
   `lint-common.yml` を個別修正する必要はありません。

6. この `README.md` の「共有 linter 一覧」に、
   対象ファイル、設定ファイル、制限事項を 1 行追記します。

7. 各 linter は `tests/pass/` と `tests/fail/` のように、最低 2 fixture を持たせます。
   `target/` には lint 対象 repo をそのまま置き、`result.json` には
   `selected_files` / `checked_projects` / `result` の expected JSON を、
   `sarif.json` には normalized SARIF を保存します。
   path 解決、config 探索、package grouping のような
   非自明な処理がある場合は `<name>/<name>.test.js` のような focused unit test を追加します。
   SARIF renderer の unit test が必要なら `<name>/render-linter-sarif.test.js` も更新し、
   shell script には `shellcheck -x -P SCRIPTDIR` を通してください。

8. 変更後は、触った面に応じて既存の validation を実行します。
   例:
   - `node .github/scripts/run-fixture-tests.js <name>`
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
