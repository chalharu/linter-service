#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"

run_hadolint() {
  local failure=0
  local path config_path

  for path in "$@"; do
    if config_path=$(hadolint_find_config "$path"); then
      printf '==> hadolint --no-color --config %s %s\n' "$config_path" "$path"
      if ! hadolint --no-color --config "$config_path" "$path"; then
        failure=1
      fi
    else
      printf '==> hadolint --no-color %s\n' "$path"
      if ! hadolint --no-color "$path"; then
        failure=1
      fi
    fi
    echo
  done

  return "$failure"
}

linter_lib::run_and_emit_json "$output_file" run_hadolint "$@"
