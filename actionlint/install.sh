#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
bin_dir="$RUNNER_TEMP/actionlint/bin"
# renovate: datasource=github-releases depName=rhysd/actionlint
actionlint_version="v1.7.12"
version_number="${actionlint_version#v}"
asset="actionlint_${version_number}_linux_amd64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/actionlint-extract"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://github.com/rhysd/actionlint/releases/download/$actionlint_version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/actionlint" "$bin_dir/actionlint"
chmod +x "$bin_dir/actionlint"
linter_lib::add_path "$bin_dir"
bash "$script_dir/../shellcheck/install.sh"
