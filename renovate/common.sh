#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

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

renovate_image_tag() {
  local base_image renovate_version_value base_hash

  base_image="${1:-$(renovate_base_image)}"
  renovate_version_value="${2:-$(renovate_version)}"

  if command -v sha256sum >/dev/null 2>&1; then
    base_hash=$(printf '%s' "$base_image" | sha256sum | awk '{print substr($1, 1, 12)}')
  elif command -v shasum >/dev/null 2>&1; then
    base_hash=$(printf '%s' "$base_image" | shasum -a 256 | awk '{print substr($1, 1, 12)}')
  else
    echo "sha256sum or shasum is required to derive the Renovate image tag" >&2
    return 1
  fi

  printf 'renovate-%s-base-%s\n' "$renovate_version_value" "$base_hash"
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
