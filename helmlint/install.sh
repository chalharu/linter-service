#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if command -v helm >/dev/null 2>&1 && helm version --short >/dev/null 2>&1; then
  exit 0
fi

# renovate: datasource=github-releases depName=helm/helm
helm_version="v4.1.3"
asset="helm-${helm_version}-linux-amd64.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/helmlint-extract"
bin_dir="$RUNNER_TEMP/helmlint/bin"

rm -rf "$extract_dir" "$bin_dir"
mkdir -p "$extract_dir" "$bin_dir"

curl -fsSL "https://get.helm.sh/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$extract_dir/linux-amd64/helm" "$bin_dir/helm"
chmod +x "$bin_dir/helm"
linter_lib::add_path "$bin_dir"
