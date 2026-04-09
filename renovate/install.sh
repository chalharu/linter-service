#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
renovate_require_container_runtime

# renovate: datasource=npm depName=renovate
renovate_version="43.104.4"
container_bin=$(renovate_container_bin)
base_image=$(renovate_base_image)
image_repository=$(renovate_image_repository)
image_tag=$(renovate_image_tag "$base_image" "$renovate_version")
image_ref=$(renovate_image_ref "$image_repository" "$image_tag")
min_release_age_days=$(renovate_npm_min_release_age_days)
dockerfile_path="$script_dir/Dockerfile"

if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

if "$container_bin" pull "$image_ref" >/dev/null 2>&1; then
  exit 0
fi

"$container_bin" build \
  --pull \
  --build-arg "RENOVATE_BASE_IMAGE=$base_image" \
  --build-arg "RENOVATE_NPM_MIN_RELEASE_AGE_DAYS=$min_release_age_days" \
  --build-arg "RENOVATE_VERSION=$renovate_version" \
  --file "$dockerfile_path" \
  --tag "$image_ref" \
  "$script_dir"

if renovate_should_push_image; then
  if ! "$container_bin" push "$image_ref" >/dev/null; then
    echo "Failed to push cached Renovate image: $image_ref" >&2
  fi
fi
