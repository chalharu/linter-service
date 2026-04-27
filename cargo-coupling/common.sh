#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

cargo_coupling::sha256_prefix() {
  local input=${1-}
  local prefix_length=${2:?}
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | sha256sum | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | shasum -a 256 | awk '{print $1}')
  elif command -v python3 >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
  else
    echo "sha256sum, shasum, or python3 is required to derive the cargo-coupling image tag" >&2
    return 1
  fi

  printf '%s\n' "${digest:0:$prefix_length}"
}

cargo_coupling::read_install_assignment() {
  local variable_name=${1:?}
  local value

  value=$(sed -n "s/^${variable_name}=\"\\([^\"]*\\)\"$/\\1/p" "$script_dir/install.sh")
  if [ -z "$value" ]; then
    echo "Failed to read ${variable_name} from $script_dir/install.sh" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

cargo_coupling_source_version() {
  printf '%s\n' "${CARGO_COUPLING_VERSION:-$(cargo_coupling::read_install_assignment cargo_coupling_version)}"
}

cargo_coupling_source_archive_sha256() {
  printf '%s\n' "${CARGO_COUPLING_SOURCE_ARCHIVE_SHA256:-$(cargo_coupling::read_install_assignment cargo_coupling_source_archive_sha256)}"
}

cargo_coupling_image_tag() {
  local source_version source_archive_sha256 dockerfile_contents build_hash

  source_version=$(cargo_coupling_source_version)
  source_archive_sha256=$(cargo_coupling_source_archive_sha256)
  dockerfile_contents=$(cat "$script_dir/Dockerfile.full")
  build_hash=$(
    cargo_coupling::sha256_prefix \
      "$(printf '%s\n%s\n%s' "$source_version" "$source_archive_sha256" "$dockerfile_contents")" \
      12
  )

  printf '%s\n' "${source_version#v}-${build_hash}"
}

cargo_coupling_image_ref() {
  local image_tag

  image_tag=$(cargo_coupling_image_tag)
  printf '%s\n' "${CARGO_COUPLING_IMAGE_REF:-localhost/linter-service-cargo-coupling:${image_tag}}"
}

cargo_coupling_container_bin() {
  local docker_bin resolved_bin podman_bin

  podman_bin="${CONTROL_PLANE_PODMAN_BIN:-/usr/bin/podman}"
  docker_bin=""
  resolved_bin=""

  if command -v docker >/dev/null 2>&1; then
    docker_bin=$(command -v docker)
    resolved_bin="$docker_bin"
  elif command -v podman >/dev/null 2>&1; then
    printf '%s\n' "$(command -v podman)"
    return 0
  else
    echo "docker or podman is required to run cargo-coupling in an isolated container" >&2
    return 1
  fi

  if command -v readlink >/dev/null 2>&1; then
    resolved_bin=$(readlink -f "$docker_bin" 2>/dev/null || printf '%s\n' "$docker_bin")
  fi

  if [ "$(basename "$resolved_bin")" = "control-plane-podman" ] && [ -x "$podman_bin" ]; then
    printf '%s\n' "$podman_bin"
    return 0
  fi

  printf '%s\n' "$docker_bin"
}

cargo_coupling_require_container_runtime() {
  if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    echo "docker or podman is required to run cargo-coupling in an isolated container" >&2
    return 1
  fi
}

cargo_coupling_analysis_path_for_manifest() {
  local manifest_path=$1
  local manifest_dir src_dir

  manifest_dir=$(dirname "$manifest_path")
  src_dir="$manifest_dir/src"

  if [ -d "$src_dir" ]; then
    printf '%s\n' "src"
    return 0
  fi

  printf '%s\n' "."
}

cargo_coupling_workdir_for_manifest() {
  local manifest_path=$1
  local manifest_dir

  manifest_dir=$(dirname "$manifest_path")
  if [ "$manifest_dir" = "." ]; then
    printf '%s\n' "/work"
    return 0
  fi

  printf '/work/%s\n' "$manifest_dir"
}
