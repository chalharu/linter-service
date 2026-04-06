#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

helmlint_find_chart_root() {
  local input_path=$1
  local current_dir candidate

  if [ -d "$input_path" ]; then
    current_dir="$input_path"
  else
    current_dir=$(dirname "$input_path")
  fi

  while :; do
    candidate="$current_dir/Chart.yaml"
    if [ -f "$candidate" ]; then
      printf '%s\n' "${current_dir#./}"
      return 0
    fi

    if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
      break
    fi

    current_dir=$(dirname "$current_dir")
  done

  return 1
}

helmlint_collect_chart_roots() {
  local output_var=$1
  shift

  local -n output_ref="$output_var"
  local -A seen=()
  local path chart_root

  output_ref=()

  for path in "$@"; do
    if ! chart_root=$(helmlint_find_chart_root "$path"); then
      continue
    fi

    if [ -z "${seen[$chart_root]+x}" ]; then
      seen["$chart_root"]=1
      output_ref+=("$chart_root")
    fi
  done
}
