#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_clippy_require_docker

base_image=$(cargo_clippy_base_image)
base_ref=$(cargo_clippy_image_ref)
build_context="$RUNNER_TEMP/cargo-clippy-image"

if ! docker image inspect "$base_ref" >/dev/null 2>&1; then
  rm -rf "$build_context"
  mkdir -p "$build_context"

  cat > "$build_context/Dockerfile" <<EOF
FROM ${base_image}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates git pkg-config \\
 && rm -rf /var/lib/apt/lists/* \\
 && rustup component add clippy
EOF

  docker build \
    --pull \
    --tag "$base_ref" \
    "$build_context"
fi

apt_packages=()
if ! mapfile -t apt_packages < <(cargo_clippy_load_apt_packages); then
  echo "cargo-clippy: failed to load linters.cargo-clippy.apt_packages" >&2
  exit 1
fi

if [ "${#apt_packages[@]}" -eq 0 ]; then
  exit 0
fi

resolved_ref=$(cargo_clippy_resolved_image_ref)
if [ "$resolved_ref" = "$base_ref" ]; then
  exit 0
fi

if docker image inspect "$resolved_ref" >/dev/null 2>&1; then
  exit 0
fi

derived_context="$RUNNER_TEMP/cargo-clippy-image-apt"
rm -rf "$derived_context"
mkdir -p "$derived_context"

# apt_packages entries are validated to ^[a-z0-9][a-z0-9+.\-]*$ by load-config.js;
# '--' prevents option injection even if validation is bypassed.
# shellcheck disable=SC2086
cat > "$derived_context/Dockerfile" <<EOF
FROM ${base_ref}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends -- ${apt_packages[*]} \\
 && rm -rf /var/lib/apt/lists/*
EOF

docker build \
  --tag "$resolved_ref" \
  "$derived_context"
