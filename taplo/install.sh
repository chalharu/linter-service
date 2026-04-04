#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
version="$(linter_lib::resolve_latest_github_release_tag tamasfe taplo)"
asset="taplo-linux-x86_64.gz"
bin_dir="$RUNNER_TEMP/taplo/bin"
download_path="$bin_dir/taplo.gz"

rm -rf "$bin_dir"
mkdir -p "$bin_dir"

curl -fsSL "https://github.com/tamasfe/taplo/releases/download/$version/$asset" -o "$download_path"
gzip -d "$download_path"
chmod +x "$bin_dir/taplo"
linter_lib::add_path "$bin_dir"
