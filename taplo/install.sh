#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=github-releases depName=tamasfe/taplo
taplo_version="0.10.0"
asset="taplo-linux-x86_64.gz"
bin_dir="$RUNNER_TEMP/taplo/bin"
download_path="$bin_dir/taplo.gz"

rm -rf "$bin_dir"
mkdir -p "$bin_dir"

curl -fsSL "https://github.com/tamasfe/taplo/releases/download/$taplo_version/$asset" -o "$download_path"
gzip -d "$download_path"
chmod +x "$bin_dir/taplo"
linter_lib::add_path "$bin_dir"
