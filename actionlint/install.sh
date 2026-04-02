#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

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
