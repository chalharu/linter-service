#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if command -v yamlfmt >/dev/null 2>&1 && yamlfmt -version >/dev/null 2>&1; then
  exit 0
fi

# renovate: datasource=github-releases depName=google/yamlfmt
yamlfmt_version="v0.21.0"
asset_version="${yamlfmt_version#v}"
asset="yamlfmt_${asset_version}_Linux_x86_64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/yamlfmt-extract"
bin_dir="$RUNNER_TEMP/yamlfmt/bin"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://github.com/google/yamlfmt/releases/download/$yamlfmt_version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/yamlfmt" "$bin_dir/yamlfmt"
chmod +x "$bin_dir/yamlfmt"
linter_lib::add_path "$bin_dir"
