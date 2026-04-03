#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if command -v editorconfig-checker >/dev/null 2>&1 && editorconfig-checker -version >/dev/null 2>&1; then
  exit 0
fi

release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/editorconfig-checker/editorconfig-checker/releases/latest)"
version="$(basename "$release_url")"
asset="ec-linux-amd64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/editorconfig-checker-extract"
bin_dir="$RUNNER_TEMP/editorconfig-checker/bin"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://github.com/editorconfig-checker/editorconfig-checker/releases/download/$version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/bin/ec-linux-amd64" "$bin_dir/editorconfig-checker"
chmod +x "$bin_dir/editorconfig-checker"
linter_lib::add_path "$bin_dir"
