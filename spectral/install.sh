#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=npm depName=@stoplight/spectral-cli
spectral_version="6.15.0"
linter_lib::install_node_tools "$RUNNER_TEMP/spectral/npm-global" "@stoplight/spectral-cli@$spectral_version"
