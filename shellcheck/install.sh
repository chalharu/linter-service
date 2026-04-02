#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/koalaman/shellcheck/releases/latest)"
version="$(basename "$release_url")"
asset="shellcheck-${version}.linux.x86_64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/shellcheck-extract"
bin_dir="$RUNNER_TEMP/shellcheck/bin"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/$version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/shellcheck-$version/shellcheck" "$bin_dir/shellcheck"
chmod +x "$bin_dir/shellcheck"
linter_lib::add_path "$bin_dir"
