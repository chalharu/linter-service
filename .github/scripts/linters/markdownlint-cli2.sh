#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:md|markdown)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    linter_lib::install_node_tools "$RUNNER_TEMP/markdownlint-cli2/npm-global" markdownlint-cli2
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    literal_paths=()
    for path in "$@"; do
      literal_paths+=(":$path")
    done

    linter_lib::run_and_emit_json \
      "$output_file" \
      markdownlint-cli2 \
      --no-globs \
      "${literal_paths[@]}"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
