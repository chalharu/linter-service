#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

markdownlint_collect_relevant_dirs() {
  local -A seen=()
  local path current_dir

  seen["."]=1
  printf '%s\n' "."

  for path in "$@"; do
    current_dir=$(dirname "$path")

    while :; do
      if [ -z "${seen[$current_dir]+x}" ]; then
        seen["$current_dir"]=1
        printf '%s\n' "$current_dir"
      fi

      if [ "$current_dir" = "." ]; then
        break
      fi

      current_dir=$(dirname "$current_dir")
    done
  done
}

markdownlint_find_unsafe_config() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.markdownlint-cli2.cjs" \
      "$dir/.markdownlint-cli2.mjs" \
      "$dir/.markdownlint.cjs" \
      "$dir/.markdownlint.mjs"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
        return 0
      fi
    done
  done

  return 1
}

markdownlint_collect_safe_configs() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.markdownlint-cli2.jsonc" \
      "$dir/.markdownlint-cli2.yaml" \
      "$dir/.markdownlint.jsonc" \
      "$dir/.markdownlint.json" \
      "$dir/.markdownlint.yaml" \
      "$dir/.markdownlint.yml"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
      fi
    done
  done
}
