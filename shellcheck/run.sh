#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
report_file="$RUNNER_TEMP/shellcheck-report.json"
stderr_file="$RUNNER_TEMP/shellcheck-stderr.log"
rm -f "$report_file" "$stderr_file"

set +e
shellcheck --format json1 -x -P SCRIPTDIR "$@" >"$report_file" 2>"$stderr_file"
exit_code=$?
set -e

node "$script_dir/shellcheck-result.js" "$report_file" "$stderr_file" "$exit_code"
