#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
textlint_require_docker

container_bin=$(textlint_container_bin)
image_ref=$(textlint_image_ref)
base_image=$(textlint_base_image)
min_release_age_days=$(textlint_npm_min_release_age_days)
build_context="$RUNNER_TEMP/textlint-image"

if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

rm -rf "$build_context"
mkdir -p "$build_context"

cat > "$build_context/Dockerfile" <<EOF
FROM ${base_image}
RUN npm install --global \\
  --ignore-scripts \\
  --loglevel=error \\
  --no-audit \\
  --no-fund \\
  --update-notifier=false \\
  --min-release-age=${min_release_age_days} \\
  textlint@15.5.2
EOF

"$container_bin" build \
  --pull \
  --tag "$image_ref" \
  "$build_context"
