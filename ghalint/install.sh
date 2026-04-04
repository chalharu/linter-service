#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
# renovate: datasource=github-releases depName=suzuki-shunsuke/ghalint
ghalint_version="v1.5.5"
version_number="${ghalint_version#v}"
asset="ghalint_${version_number}_linux_amd64.tar.gz"
bin_dir="$RUNNER_TEMP/ghalint/bin"
mkdir -p "$bin_dir"
curl -fsSL "https://github.com/suzuki-shunsuke/ghalint/releases/download/$ghalint_version/$asset" -o "$RUNNER_TEMP/$asset"
tar -xzf "$RUNNER_TEMP/$asset" -C "$bin_dir"
chmod +x "$bin_dir/ghalint"
linter_lib::add_path "$bin_dir"
