#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
native_sarif_file="$RUNNER_TEMP/biome-native.sarif"
rm -f "$native_sarif_file"

set +e
biome lint \
  --colors=off \
  --error-on-warnings \
  --no-errors-on-unmatched \
  --reporter=sarif \
  --reporter-file="$native_sarif_file" \
  "$@" >"$output_file" 2>&1
exit_code=$?
set -e

if [ ! -s "$native_sarif_file" ]; then
  echo "biome native SARIF reporter did not produce output" >&2
  exit 1
fi

linter_lib::emit_json_result "$exit_code" "$output_file"
