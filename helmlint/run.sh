#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"

run_helmlint() {
  local failure=0
  local chart_root
  local -a chart_roots=()

  helmlint_collect_chart_roots chart_roots "$@"

  for chart_root in "${chart_roots[@]}"; do
    printf '==> helm lint %s\n' "$chart_root"
    if ! helm lint "$chart_root"; then
      failure=1
    fi
    echo
  done

  return "$failure"
}

linter_lib::run_and_emit_json "$output_file" run_helmlint "$@"
