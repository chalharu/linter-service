#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=npm depName=@biomejs/biome
biome_version="2.4.10"
linter_lib::install_node_tools "$RUNNER_TEMP/biome/npm-global" "@biomejs/biome@$biome_version"
