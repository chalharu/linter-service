#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=pypi depName=zizmor
zizmor_version="1.27.0"
linter_lib::install_python_tools "$RUNNER_TEMP/zizmor-venv" "zizmor==$zizmor_version"
