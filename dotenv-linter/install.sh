#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if command -v dotenv-linter >/dev/null 2>&1 && dotenv-linter --version >/dev/null 2>&1; then
  exit 0
fi

release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/dotenv-linter/dotenv-linter/releases/latest)"
version="$(basename "$release_url")"
asset="dotenv-linter-linux-x86_64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/dotenv-linter-extract"
bin_dir="$RUNNER_TEMP/dotenv-linter/bin"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://github.com/dotenv-linter/dotenv-linter/releases/download/$version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/dotenv-linter" "$bin_dir/dotenv-linter"
chmod +x "$bin_dir/dotenv-linter"
linter_lib::add_path "$bin_dir"
