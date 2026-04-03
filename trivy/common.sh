#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

trivy_image_ref() {
  printf '%s\n' "${TRIVY_IMAGE_REF:-ghcr.io/aquasecurity/trivy:0.69.3@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689}"
}

trivy_platform() {
  printf '%s\n' "${TRIVY_PLATFORM:-linux/amd64}"
}

trivy_container_bin() {
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
    echo "docker or podman is required to run trivy in an isolated container" >&2
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

trivy_require_container_runtime() {
  if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    echo "docker or podman is required to run trivy in an isolated container" >&2
    return 1
  fi
}

trivy_find_root_config() {
  local candidate

  for candidate in trivy.yaml trivy.yml; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

trivy_copy_root_support_files() {
  local target_root=$1

  linter_lib::copy_first_existing_path "$target_root" trivy.yaml trivy.yml || true

  if [ -f .trivyignore ]; then
    local destination="$target_root/.trivyignore"
    mkdir -p "$(dirname "$destination")"
    cp .trivyignore "$destination"
  fi
}
