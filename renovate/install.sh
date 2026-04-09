#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
renovate_require_container_runtime

# renovate: datasource=npm depName=renovate
renovate_version="43.104.7"
container_bin=$(renovate_container_bin)
base_image=$(renovate_base_image)
image_repository=$(renovate_image_repository)
min_release_age_days=$(renovate_npm_min_release_age_days)
dockerfile_path="$script_dir/Dockerfile"
cleanup_script_path="$script_dir/../.github/scripts/prune-renovate-cache-images.js"
declare -a image_tags=()
declare -a image_refs=()
primary_image_ref=""
resolved_image_ref=""

mapfile -t image_tags < <(renovate_image_tags "$base_image" "$renovate_version")
if [ "${#image_tags[@]}" -eq 0 ]; then
  echo "Failed to derive any Renovate cache image tags" >&2
  exit 1
fi

for image_tag in "${image_tags[@]}"; do
  image_ref=$(renovate_image_ref "$image_repository" "$image_tag")
  image_refs+=("$image_ref")
done
primary_image_ref="${image_refs[0]}"

ensure_local_image_tags() {
  local source_image_ref=${1:?}
  local target_image_ref

  for target_image_ref in "${image_refs[@]}"; do
    if [ "$target_image_ref" = "$source_image_ref" ]; then
      continue
    fi

    if "$container_bin" image inspect "$target_image_ref" >/dev/null 2>&1; then
      continue
    fi

    "$container_bin" tag "$source_image_ref" "$target_image_ref"
  done
}

for image_ref in "${image_refs[@]}"; do
  if "$container_bin" image inspect "$image_ref" >/dev/null 2>&1; then
    resolved_image_ref="$image_ref"
    break
  fi
done

if [ -z "$resolved_image_ref" ]; then
  for image_ref in "${image_refs[@]}"; do
    if "$container_bin" pull "$image_ref" >/dev/null 2>&1; then
      resolved_image_ref="$image_ref"
      break
    fi
  done
fi

if [ -z "$resolved_image_ref" ]; then
  "$container_bin" build \
    --pull \
    --build-arg "RENOVATE_BASE_IMAGE=$base_image" \
    --build-arg "RENOVATE_NPM_MIN_RELEASE_AGE_DAYS=$min_release_age_days" \
    --build-arg "RENOVATE_VERSION=$renovate_version" \
    --file "$dockerfile_path" \
    --tag "$primary_image_ref" \
    "$script_dir"
  resolved_image_ref="$primary_image_ref"
fi

ensure_local_image_tags "$resolved_image_ref"

if renovate_should_push_image; then
  for image_ref in "${image_refs[@]}"; do
    if ! "$container_bin" push "$image_ref" >/dev/null; then
      echo "Failed to push cached Renovate image: $image_ref" >&2
    fi
  done

  if [ -f "$cleanup_script_path" ]; then
    if ! RENOVATE_IMAGE_REPOSITORY="$image_repository" node "$cleanup_script_path"; then
      echo "Failed to prune stale Renovate cache images from GHCR" >&2
    fi
  fi
fi
