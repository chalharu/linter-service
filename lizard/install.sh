#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=pypi depName=lizard
lizard_version="1.21.3"
linter_lib::install_python_tools "$RUNNER_TEMP/lizard-venv" "lizard==$lizard_version"
