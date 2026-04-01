#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Shared helpers keep the JSON contract and path handling consistent.
# shellcheck disable=SC1091
source "$script_dir/../linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
^\.github\/workflows\/.+\.(?:yaml|yml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    bin_dir="$RUNNER_TEMP/actionlint/bin"
    mkdir -p "$bin_dir"
    curl -sSfL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash \
      -o "$RUNNER_TEMP/download-actionlint.bash"
    (
      cd "$bin_dir" || exit 1
      bash "$RUNNER_TEMP/download-actionlint.bash" latest
    )
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    linter_lib::run_and_emit_json "$output_file" actionlint "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
