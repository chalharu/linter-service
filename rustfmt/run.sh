#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
rustfmt_prepare_env
output_file="$RUNNER_TEMP/linter-output.txt"

run_rustfmt() {
  local failure=0
  local current_file
  local -a unique_files=()
  local -A seen_files=()

  for current_file in "$@"; do
    if [ -n "${seen_files[$current_file]+x}" ]; then
      continue
    fi

    seen_files["$current_file"]=1
    unique_files+=("$current_file")
  done

  for current_file in "${unique_files[@]}"; do
    printf '==> rustfmt --check %s\n' "$current_file"
    if ! rustfmt --check "$current_file"; then
      failure=1
    fi
    echo
  done

  return "$failure"
}

linter_lib::run_and_emit_json "$output_file" run_rustfmt "$@"
