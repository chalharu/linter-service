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
cargo_coupling_source_archive_sha256="0bbfe05d0302fd6752b5e4b512226820e13e52498dc3bc1ce03e172e19cbd556"
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

verify_source_archive_sha256() {
  local archive_path=${1:?}
  local expected_sha256 actual_sha256

  expected_sha256="${CARGO_COUPLING_SOURCE_ARCHIVE_SHA256:-$cargo_coupling_source_archive_sha256}"

  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256=$(sha256sum "$archive_path" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  else
    echo "sha256sum or shasum is required to verify cargo-coupling source archive integrity" >&2
    return 1
  fi

  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "cargo-coupling source archive checksum mismatch: expected $expected_sha256 but got $actual_sha256" >&2
    return 1
  fi
}

trap cleanup_build_root EXIT

curl -fsSL "$source_url" -o "$archive_path"
verify_source_archive_sha256 "$archive_path"
tar -xzf "$archive_path" -C "$source_dir" --strip-components=1
cp "$script_dir/Dockerfile.full" "$dockerfile_path"

"$container_bin" build \
  --pull \
  --file "$dockerfile_path" \
  --tag "$image_ref" \
  "$source_dir"
