#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

cargo_clippy_base_image() {
  printf '%s\n' "${CARGO_CLIPPY_BASE_IMAGE:-docker.io/library/rust:1-bookworm}"
}

cargo_clippy_image_ref() {
  printf '%s\n' "${CARGO_CLIPPY_IMAGE_REF:-localhost/linter-service-cargo-clippy:rust-1-bookworm}"
}

cargo_clippy_require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run cargo-clippy in an isolated container" >&2
    return 1
  fi
}
