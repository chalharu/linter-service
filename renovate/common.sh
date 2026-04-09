#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

renovate::sha256_prefix() {
  local input=${1-}
  local prefix_length=${2:?}
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | sha256sum | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | shasum -a 256 | awk '{print $1}')
  else
    echo "sha256sum or shasum is required to derive Renovate cache identifiers" >&2
    return 1
  fi

  printf '%s\n' "${digest:0:$prefix_length}"
}

renovate::read_dockerfile_arg() {
  local arg_name=${1:?}
  local value

  value=$(sed -n "s/^ARG ${arg_name}=//p" "$script_dir/Dockerfile")
  if [ -z "$value" ]; then
    echo "Failed to read ${arg_name} from $script_dir/Dockerfile" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

renovate::read_install_assignment() {
  local variable_name=${1:?}
  local value

  value=$(sed -n "s/^${variable_name}=\"\\([^\"]*\\)\"$/\\1/p" "$script_dir/install.sh")
  if [ -z "$value" ]; then
    echo "Failed to read ${variable_name} from $script_dir/install.sh" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

renovate_base_image() {
  printf '%s\n' "${RENOVATE_BASE_IMAGE:-$(renovate::read_dockerfile_arg RENOVATE_BASE_IMAGE)}"
}

renovate_version() {
  printf '%s\n' "${RENOVATE_VERSION:-$(renovate::read_install_assignment renovate_version)}"
}

renovate_image_repository() {
  local repository owner repo_name

  repository="${GITHUB_REPOSITORY:-chalharu/linter-service}"
  owner="${GITHUB_REPOSITORY_OWNER:-${repository%%/*}}"
  repo_name="${repository#*/}"

  printf '%s\n' "${RENOVATE_IMAGE_REPOSITORY:-ghcr.io/${owner}/${repo_name}-renovate}"
}

renovate_cache_repository_path() {
  printf '%s\n' "${RENOVATE_CACHE_REPOSITORY_PATH:-$(cd "$script_dir/.." && pwd)}"
}

renovate_cache_source_head_sha() {
  local value repository_path

  value="${RENOVATE_CACHE_SOURCE_HEAD_SHA:-}"
  if [ -n "$value" ]; then
    if [[ ! "$value" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
      echo "RENOVATE_CACHE_SOURCE_HEAD_SHA must be a hexadecimal git commit SHA" >&2
      return 1
    fi

    printf '%s\n' "${value,,}"
    return 0
  fi

  repository_path=$(renovate_cache_repository_path)
  git -C "$repository_path" rev-parse HEAD
}

renovate_cache_branch_name() {
  local value repository_path

  value="${RENOVATE_CACHE_BRANCH_NAME:-}"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi

  repository_path=$(renovate_cache_repository_path)
  value=$(git -C "$repository_path" branch --show-current 2>/dev/null || true)
  if [ -z "$value" ]; then
    return 1
  fi

  printf '%s\n' "$value"
}

renovate_cache_pr_number() {
  local value="${RENOVATE_CACHE_PR_NUMBER:-}"

  if [ -z "$value" ]; then
    return 1
  fi

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "RENOVATE_CACHE_PR_NUMBER must be a positive integer" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

renovate::sanitize_cache_key_component() {
  local value=${1:?}
  local normalized component_hash

  normalized=$(
    printf '%s' "$value" |
      tr '[:upper:]' '[:lower:]' |
      sed -e 's/[^a-z0-9._-]/-/g' -e 's/-\{2,\}/-/g' -e 's/^[.-]*//' -e 's/[.-]*$//'
  )

  if [ -z "$normalized" ]; then
    normalized="ref"
  fi

  if [ "${#normalized}" -gt 48 ]; then
    component_hash=$(renovate::sha256_prefix "$value" 8)
    normalized="${normalized:0:39}-${component_hash}"
  fi

  printf '%s\n' "$normalized"
}

renovate_image_tags() {
  local base_image renovate_version_value base_hash branch_name pr_number head_sha
  local -a tags=()

  base_image="${1:-$(renovate_base_image)}"
  renovate_version_value="${2:-$(renovate_version)}"
  base_hash=$(renovate::sha256_prefix "$base_image" 12)

  if [ -n "${RENOVATE_IMAGE_TAG:-}" ]; then
    printf '%s\n' "$RENOVATE_IMAGE_TAG"
    return 0
  fi

  if pr_number=$(renovate_cache_pr_number 2>/dev/null); then
    tags+=("cache-pr-${pr_number}-renovate-${renovate_version_value}-base-${base_hash}")
  fi

  if branch_name=$(renovate_cache_branch_name 2>/dev/null); then
    tags+=("cache-branch-$(renovate::sanitize_cache_key_component "$branch_name")-renovate-${renovate_version_value}-base-${base_hash}")
  fi

  if [ "${#tags[@]}" -eq 0 ]; then
    head_sha=$(renovate_cache_source_head_sha)
    tags+=("cache-head-${head_sha:0:12}-renovate-${renovate_version_value}-base-${base_hash}")
  fi

  printf '%s\n' "${tags[@]}" | awk '!seen[$0]++'
}

renovate_image_tag() {
  local base_image renovate_version_value

  base_image="${1:-$(renovate_base_image)}"
  renovate_version_value="${2:-$(renovate_version)}"

  renovate_image_tags "$base_image" "$renovate_version_value" | sed -n '1p'
}

renovate_image_ref() {
  if [ -n "${RENOVATE_IMAGE_REF:-}" ]; then
    printf '%s\n' "$RENOVATE_IMAGE_REF"
    return 0
  fi

  printf '%s:%s\n' "${1:-$(renovate_image_repository)}" "${2:-$(renovate_image_tag)}"
}

renovate_container_bin() {
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
    echo "docker or podman is required to run renovate in an isolated container" >&2
    return 1
  fi

  if command -v readlink >/dev/null 2>&1; then
    resolved_bin=$(readlink -f "$docker_bin" 2>/dev/null || printf '%s\n' "$docker_bin")
  fi

  # The control-plane docker wrapper injects rootful-service defaults that break
  # this networkless renovate invocation; the underlying podman binary does not.
  if [ "$(basename "$resolved_bin")" = "control-plane-podman" ] && [ -x "$podman_bin" ]; then
    printf '%s\n' "$podman_bin"
    return 0
  fi

  printf '%s\n' "$docker_bin"
}

renovate_npm_min_release_age_days() {
  local days="${RENOVATE_NPM_MIN_RELEASE_AGE_DAYS:-3}"

  if [[ ! "$days" =~ ^[0-9]+$ ]]; then
    echo "RENOVATE_NPM_MIN_RELEASE_AGE_DAYS must be a non-negative integer" >&2
    return 1
  fi

  printf '%s\n' "$days"
}

renovate_should_push_image() {
  case "${RENOVATE_PUSH_IMAGE:-false}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
  esac

  return 1
}

renovate_require_container_runtime() {
  if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
    echo "docker or podman is required to run renovate in an isolated container" >&2
    return 1
  fi
}

renovate::supported_config_paths() {
  cat <<'EOF'
renovate.json
renovate.json5
.github/renovate.json
.github/renovate.json5
.gitlab/renovate.json
.gitlab/renovate.json5
.renovaterc
.renovaterc.json
.renovaterc.json5
EOF
}

renovate::is_supported_config_path() {
  local candidate=${1:-}

  case "$candidate" in
    renovate.json|renovate.json5|.github/renovate.json|.github/renovate.json5|.gitlab/renovate.json|.gitlab/renovate.json5|.renovaterc|.renovaterc.json|.renovaterc.json5)
      return 0
      ;;
  esac

  return 1
}

renovate::resolve_config_path() {
  local candidate

  while IFS= read -r candidate; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(renovate::supported_config_paths)

  echo "No supported Renovate config file found." >&2
  return 1
}
