#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
files=("$@")
temp_repo="$RUNNER_TEMP/textlint/repo"
rules_dir="$RUNNER_TEMP/textlint/preset"

run_textlint() {
  local exit_code path preset_name preset_spec raw_output_path runtime_json safe_config_path
  safe_config_path="$temp_repo/.textlintrc"
  raw_output_path="$RUNNER_TEMP/textlint/raw-output.txt"

  rm -rf "$temp_repo" "$rules_dir" "$raw_output_path"
  mkdir -p "$temp_repo" "$rules_dir"

  runtime_json="$(
    node - "$script_dir/textlint-config.js" "$PWD" "$safe_config_path" <<'NODE'
const [helperPath, repositoryPath, outputPath] = process.argv.slice(2);
const { resolveTextlintRuntime } = require(helperPath);
process.stdout.write(
  JSON.stringify(
    resolveTextlintRuntime({
      outputPath,
      repositoryPath,
    }),
  ),
);
NODE
  )"
  preset_name="$(node -pe 'JSON.parse(process.argv[1]).presetPackageName' "$runtime_json")"
  preset_spec="$(node -pe 'JSON.parse(process.argv[1]).presetPackageSpec' "$runtime_json")"

  npm install \
    --prefix "$rules_dir" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --no-save \
    "$preset_spec" >/dev/null

  linter_lib::copy_paths_to_root "$temp_repo" "${files[@]}"

  for path in "${files[@]}"; do
    if [ ! -f "$temp_repo/$path" ]; then
      echo "failed to prepare textlint target: $path" >&2
      return 1
    fi
  done

  if (
    cd "$temp_repo" || exit 1
    textlint \
      --config .textlintrc \
      --format unix \
      --no-color \
      --preset "$preset_name" \
      --rules-base-directory "$rules_dir/node_modules" \
      "${files[@]}"
  ) >"$raw_output_path" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  node - "$raw_output_path" "$temp_repo" <<'NODE'
const fs = require("node:fs");

const [outputPath, tempRepo] = process.argv.slice(2);
const source = fs.existsSync(outputPath)
  ? fs.readFileSync(outputPath, "utf8")
  : "";
const normalizedPrefix = `${tempRepo.replace(/\\/gu, "/").replace(/\/$/u, "")}/`;

process.stdout.write(source.split(normalizedPrefix).join(""));
NODE

  return "$exit_code"
}

linter_lib::run_and_emit_json "$output_file" run_textlint
