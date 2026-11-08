#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

# renovate: datasource=docker depName=library/rust versioning=docker
cargo_clippy_pinned_base_image_version="docker.io/library/rust:1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c"

cargo_clippy_base_image() {
  printf '%s\n' "${CARGO_CLIPPY_BASE_IMAGE:-$cargo_clippy_pinned_base_image_version}"
}

cargo_clippy_image_ref() {
  printf '%s\n' "${CARGO_CLIPPY_IMAGE_REF:-localhost/linter-service-cargo-clippy:rust-1-bookworm-sysdeps1}"
}

cargo_clippy_require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run cargo-clippy in an isolated container" >&2
    return 1
  fi
}

cargo_clippy_repository_path() {
  if [ -n "${SOURCE_REPOSITORY_PATH:-}" ]; then
    printf '%s\n' "$SOURCE_REPOSITORY_PATH"
  else
    printf '%s\n' "$PWD"
  fi
}

cargo_clippy_load_apt_packages() {
  local repo_path
  repo_path=$(cargo_clippy_repository_path)
  node - "$repo_path" "$script_dir/load-config.js" <<'NODE'
const [repoPath, loaderPath] = process.argv.slice(2);
const { loadConfig } = require(loaderPath);
const config = loadConfig(repoPath);
for (const pkg of config.apt_packages || []) {
  process.stdout.write(`${pkg}\n`);
}
NODE
}

cargo_clippy_resolved_image_ref() {
  local repo_path base_ref
  repo_path=$(cargo_clippy_repository_path)
  base_ref=$(cargo_clippy_image_ref)
  node - "$repo_path" "$base_ref" "$script_dir/load-config.js" <<'NODE'
const path = require("node:path");
const [repoPath, baseRef, loaderPath] = process.argv.slice(2);
const { loadConfig } = require(loaderPath);
const loaderDir = path.dirname(loaderPath);
const helperPath = path.join(loaderDir, "..", ".github", "scripts", "cargo-apt-packages.js");
const { resolveAptImageRef } = require(helperPath);
let config;
try {
  config = loadConfig(repoPath);
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
process.stdout.write(resolveAptImageRef(baseRef, config.apt_packages || []));
NODE
}
