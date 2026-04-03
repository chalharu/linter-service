#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
linter_lib::install_node_tools \
  "$RUNNER_TEMP/textlint/tool/npm-global" \
  --ignore-scripts \
  textlint@15.5.2
