#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

yamlfmt_find_config() {
  local candidate

  for candidate in .yamlfmt yamlfmt.yml yamlfmt.yaml .yamlfmt.yaml .yamlfmt.yml; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

yamlfmt_first_difference_line() {
  local original_path=$1
  local formatted_path=$2
  local line_number

  line_number=$(
    diff -U0 "$original_path" "$formatted_path" 2>/dev/null |
      sed -n 's/^@@ -\([0-9]\+\)\(,[0-9]\+\)\? +[0-9]\+\(,[0-9]\+\)\? @@.*/\1/p' |
      head -n 1
  )

  if [ -z "$line_number" ] || [ "$line_number" -le 0 ]; then
    printf '1\n'
    return 0
  fi

  printf '%s\n' "$line_number"
}

yamlfmt_collect_line_summaries() {
  local yamlfmt_config=$1
  shift

  local scratch_dir="$RUNNER_TEMP/yamlfmt-line-summaries"
  local selected_path formatted_copy copy_path display_path line_number

  rm -rf "$scratch_dir"
  mkdir -p "$scratch_dir"

  for selected_path in "$@"; do
    if [ ! -f "$selected_path" ]; then
      continue
    fi

    display_path="${selected_path#./}"
    copy_path="$display_path"
    if [ "${selected_path#/}" != "$selected_path" ]; then
      copy_path="absolute/${selected_path#/}"
    fi

    formatted_copy="$scratch_dir/$copy_path"
    mkdir -p "$(dirname "$formatted_copy")"
    cp "$selected_path" "$formatted_copy"

    if ! yamlfmt -conf "$yamlfmt_config" "$formatted_copy" >/dev/null 2>&1; then
      continue
    fi

    if cmp -s "$selected_path" "$formatted_copy"; then
      continue
    fi

    line_number=$(yamlfmt_first_difference_line "$selected_path" "$formatted_copy")
    printf '%s:%s: yamlfmt would reformat this file\n' "$display_path" "$line_number"
  done

  rm -rf "$scratch_dir"
}
