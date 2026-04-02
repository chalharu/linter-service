#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
temp_repo="$RUNNER_TEMP/editorconfig-checker-repo"
temp_config="$temp_repo/.editorconfig-checker.shared.json"
files=("$@")
relevant_dirs=()
editorconfig_files=()
base_config=""

rm -rf "$temp_repo"
mkdir -p "$temp_repo"

linter_lib::copy_paths_to_root "$temp_repo" "${files[@]}"
mapfile -t relevant_dirs < <(editorconfig_collect_relevant_dirs "${files[@]}")
mapfile -t editorconfig_files < <(editorconfig_collect_editorconfig_files "${relevant_dirs[@]}")

if [ "${#editorconfig_files[@]}" -gt 0 ]; then
  linter_lib::copy_paths_to_root "$temp_repo" "${editorconfig_files[@]}"
fi

if resolved_config="$(editorconfig_resolve_repo_config)"; then
  base_config="$resolved_config"
fi

run_editorconfig_checker() {
  editorconfig_write_temp_config "$temp_config" "$base_config" "${files[@]}"
  cd "$temp_repo" || exit 1
  editorconfig-checker -config .editorconfig-checker.shared.json
}

linter_lib::run_and_emit_json "$output_file" run_editorconfig_checker
