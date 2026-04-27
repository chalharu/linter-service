#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
native_sarif_file="$RUNNER_TEMP/ruff-native.sarif"
stderr_file="$RUNNER_TEMP/ruff-stderr.log"
rm -f "$native_sarif_file" "$stderr_file"

set +e
ruff check \
  --force-exclude \
  --no-cache \
  --output-format sarif \
  --output-file "$native_sarif_file" \
  "$@" >/dev/null 2>"$stderr_file"
exit_code=$?
set -e

if [ ! -s "$native_sarif_file" ]; then
  echo "ruff native SARIF output was empty or missing" >&2
  if [ -s "$stderr_file" ]; then
    cat "$stderr_file" >&2
  fi
  exit 1
fi

if [ -s "$stderr_file" ]; then
  cat "$stderr_file" >&2
fi
rm -f "$stderr_file"

linter_lib::emit_json_result_with_sarif "$exit_code" "$native_sarif_file"
