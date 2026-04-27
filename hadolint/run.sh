#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
native_sarif_file="$RUNNER_TEMP/hadolint-native.sarif"
sarif_dir="$RUNNER_TEMP/hadolint-sarif"
stderr_dir="$RUNNER_TEMP/hadolint-stderr"
rm -f "$native_sarif_file"
rm -rf "$sarif_dir" "$stderr_dir"
mkdir -p "$sarif_dir" "$stderr_dir"

run_hadolint() {
  local failure=0
  local index=0
  local path config_path part_exit sarif_part stderr_part
  local -a command=()

  for path in "$@"; do
    index=$((index + 1))
    sarif_part="$sarif_dir/$index.sarif"
    stderr_part="$stderr_dir/$index.log"

    if config_path=$(hadolint_find_config "$path"); then
      command=(hadolint --no-color --format sarif --config "$config_path" "$path")
    else
      command=(hadolint --no-color --format sarif "$path")
    fi

    set +e
    "${command[@]}" >"$sarif_part" 2>"$stderr_part"
    part_exit=$?
    set -e

    if [ ! -s "$sarif_part" ]; then
      echo "hadolint native SARIF output was empty or missing for $path" >&2
      if [ -s "$stderr_part" ]; then
        cat "$stderr_part" >&2
      fi
      return 1
    fi

    if [ -s "$stderr_part" ]; then
      cat "$stderr_part" >&2
    fi

    if [ "$part_exit" -ne 0 ]; then
      failure=1
    fi
  done

  node "$script_dir/merge-sarif.js" "$sarif_dir" "$native_sarif_file"
  linter_lib::emit_json_result_with_sarif "$failure" "$native_sarif_file"
  return 0
}

run_hadolint "$@"
