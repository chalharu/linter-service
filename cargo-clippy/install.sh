#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_clippy_require_docker

image_ref=$(cargo_clippy_image_ref)
base_image=$(cargo_clippy_base_image)
build_context="$RUNNER_TEMP/cargo-clippy-image"

if docker image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

rm -rf "$build_context"
mkdir -p "$build_context"

cat > "$build_context/Dockerfile" <<EOF
FROM ${base_image}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates git \\
 && rm -rf /var/lib/apt/lists/* \\
 && rustup component add clippy
EOF

docker build \
  --pull \
  --tag "$image_ref" \
  "$build_context"
