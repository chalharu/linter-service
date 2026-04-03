#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
temp_repo="$RUNNER_TEMP/ghalint-repo"
rm -rf "$temp_repo"
mkdir -p "$temp_repo"
linter_lib::copy_paths_to_root "$temp_repo" "$@"
linter_lib::copy_first_existing_path "$temp_repo" \
  .ghalint.yaml \
  .ghalint.yml \
  ghalint.yaml \
  ghalint.yml \
  .github/ghalint.yaml \
  .github/ghalint.yml || true

run_ghalint() {
  cd "$temp_repo" || exit 1
  GHALINT_LOG_COLOR=never ghalint run
}

linter_lib::run_and_emit_json "$output_file" run_ghalint
