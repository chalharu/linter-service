#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
trivy_require_container_runtime

container_bin=$(trivy_container_bin)
image_ref=$(trivy_image_ref)
platform=$(trivy_platform)

if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

"$container_bin" pull --platform "$platform" "$image_ref" >/dev/null
