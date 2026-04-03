#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

textlint_base_image() {
  printf '%s\n' "${TEXTLINT_BASE_IMAGE:-docker.io/library/node:24-bookworm}"
}

textlint_image_ref() {
  printf '%s\n' "${TEXTLINT_IMAGE_REF:-localhost/linter-service-textlint:node-24-bookworm}"
}

textlint_container_bin() {
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
    echo "docker or podman is required to run textlint in an isolated container" >&2
    return 1
  fi

  if command -v readlink >/dev/null 2>&1; then
    resolved_bin=$(readlink -f "$docker_bin" 2>/dev/null || printf '%s\n' "$docker_bin")
  fi

  # The control-plane docker wrapper injects rootful-service defaults that break
  # this networkless textlint invocation; the underlying podman binary does not.
  if [ "$(basename "$resolved_bin")" = "control-plane-podman" ] && [ -x "$podman_bin" ]; then
    printf '%s\n' "$podman_bin"
    return 0
  fi

  printf '%s\n' "$docker_bin"
}

textlint_npm_min_release_age_days() {
  local days="${TEXTLINT_NPM_MIN_RELEASE_AGE_DAYS:-3}"

  if [[ ! "$days" =~ ^[0-9]+$ ]]; then
    echo "TEXTLINT_NPM_MIN_RELEASE_AGE_DAYS must be a non-negative integer" >&2
    return 1
  fi

  printf '%s\n' "$days"
}

textlint_require_docker() {
  if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    echo "docker or podman is required to run textlint in an isolated container" >&2
    return 1
  fi
}
