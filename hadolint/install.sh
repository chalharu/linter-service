#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if command -v hadolint >/dev/null 2>&1 && hadolint --version >/dev/null 2>&1; then
  exit 0
fi

version="$(linter_lib::resolve_latest_github_release_tag hadolint hadolint)"
asset="hadolint-linux-x86_64"
bin_dir="$RUNNER_TEMP/hadolint/bin"

rm -rf "$bin_dir"
mkdir -p "$bin_dir"

curl -fsSL "https://github.com/hadolint/hadolint/releases/download/$version/$asset" -o "$bin_dir/hadolint"
chmod +x "$bin_dir/hadolint"
linter_lib::add_path "$bin_dir"
