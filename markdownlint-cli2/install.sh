#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=npm depName=markdownlint-cli2
markdownlint_cli2_version="0.22.0"
linter_lib::install_node_tools "$RUNNER_TEMP/markdownlint-cli2/npm-global" "markdownlint-cli2@$markdownlint_cli2_version"
