#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
enriched_output_file="$RUNNER_TEMP/yamlfmt-output-enriched.txt"
summary_file="$RUNNER_TEMP/yamlfmt-line-summary.txt"
yamlfmt_config=""

if ! yamlfmt_config="$(yamlfmt_find_config)"; then
  yamlfmt_config="$RUNNER_TEMP/yamlfmt.yaml"
  cat > "$yamlfmt_config" <<'EOF'
formatter:
  type: basic
EOF
fi

set +e
yamlfmt \
  -lint \
  -conf "$yamlfmt_config" \
  "$@" >"$output_file" 2>&1
exit_code=$?
set -e

if [ "$exit_code" -ne 0 ]; then
  yamlfmt_collect_line_summaries "$yamlfmt_config" "$@" > "$summary_file"
  if [ -s "$summary_file" ]; then
    cat "$summary_file" > "$enriched_output_file"
    if [ -s "$output_file" ]; then
      printf '\n' >> "$enriched_output_file"
      cat "$output_file" >> "$enriched_output_file"
    fi
    mv "$enriched_output_file" "$output_file"
  fi
  rm -f "$summary_file" "$enriched_output_file"
fi

linter_lib::emit_json_result "$exit_code" "$output_file"
