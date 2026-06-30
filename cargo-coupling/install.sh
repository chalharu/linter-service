#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_coupling_require_container_runtime

container_bin=$(cargo_coupling_container_bin)
# renovate: datasource=github-tags depName=nwiizo/cargo-coupling
cargo_coupling_version="v0.3.3"
image_ref=$(cargo_coupling_image_ref)
build_root="$RUNNER_TEMP/cargo-coupling-image"
archive_path="$build_root/cargo-coupling.tar.gz"
source_dir="$build_root/source"
dockerfile_path="$source_dir/Dockerfile.full"
source_url="https://github.com/nwiizo/cargo-coupling/archive/refs/tags/${cargo_coupling_version}.tar.gz"

if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

rm -rf "$build_root"
mkdir -p "$source_dir"

cleanup_build_root() {
  rm -rf "$build_root"
}

trap cleanup_build_root EXIT

curl -fsSL "$source_url" -o "$archive_path"
tar -xzf "$archive_path" -C "$source_dir" --strip-components=1
cp "$script_dir/Dockerfile.full" "$dockerfile_path"

"$container_bin" build \
  --pull \
  --file "$dockerfile_path" \
  --tag "$image_ref" \
  "$source_dir"
