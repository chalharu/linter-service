#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
renovate_require_container_runtime

container_bin=$(renovate_container_bin)
image_ref=$(renovate_image_ref)
base_image=$(renovate_base_image)
min_release_age_days=$(renovate_npm_min_release_age_days)
build_context="$RUNNER_TEMP/renovate-image"
# renovate: datasource=npm depName=renovate
renovate_version="43.104.4"

if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

rm -rf "$build_context"
mkdir -p "$build_context"

cat > "$build_context/Dockerfile" <<EOF
FROM ${base_image}
RUN apt-get update \\
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/* \\
  && npm install --global \\
    --ignore-scripts \\
    --loglevel=error \\
    --no-audit \\
    --no-fund \\
    --update-notifier=false \\
    --min-release-age=${min_release_age_days} \\
    renovate@$renovate_version
EOF

"$container_bin" build \
  --pull \
  --tag "$image_ref" \
  "$build_context"
