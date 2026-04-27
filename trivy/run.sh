#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
trivy_require_container_runtime
workspace_root="$RUNNER_TEMP/trivy-workspace"
source_root="$workspace_root/source"
report_path="$workspace_root/trivy-report.sarif"
stderr_path="$workspace_root/trivy-stderr.txt"
container_bin=$(trivy_container_bin)
image_ref=$(trivy_image_ref)
platform=$(trivy_platform)
user_id=$(id -u)
group_id=$(id -g)

docker_run_common=(
  --rm
  --platform "$platform"
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --network=none
  --user "$user_id:$group_id"
  --workdir /work
  --mount "type=bind,src=$source_root,dst=/work,readonly"
  --env HOME=/tmp
)

run_trivy() {
  local exit_code=0
  local config_path path
  local -a trivy_args=()

  rm -rf "$workspace_root"
  mkdir -p "$source_root"

  linter_lib::copy_paths_to_root "$source_root" "$@"
  trivy_copy_root_support_files "$source_root"

  for path in "$@"; do
    if [ ! -f "$source_root/$path" ]; then
      echo "failed to prepare trivy target: $path" >&2
      return 1
    fi
  done

  if config_path=$(trivy_find_root_config 2>/dev/null); then
    trivy_args+=(--config "$config_path")
  fi

  if "$container_bin" run \
    "${docker_run_common[@]}" \
    "$image_ref" \
    config \
      --skip-check-update \
      --skip-version-check \
      --disable-telemetry \
      --quiet \
      --format sarif \
      --exit-code 1 \
      "${trivy_args[@]}" \
      /work >"$report_path" 2>"$stderr_path"; then
    exit_code=0
  else
    exit_code=$?
  fi

  if [ ! -s "$report_path" ]; then
    echo "trivy native SARIF output was empty or missing" >&2
    if [ -s "$stderr_path" ]; then
      cat "$stderr_path" >&2
    fi
    return 1
  fi

  if [ -s "$stderr_path" ]; then
    cat "$stderr_path" >&2
  fi

  linter_lib::emit_json_result_with_sarif "$exit_code" "$report_path"
  return 0
}

run_trivy "$@"
