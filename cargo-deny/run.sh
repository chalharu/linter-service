#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_deny_prepare_env
cargo_deny_require_docker
output_file="$RUNNER_TEMP/linter-output.txt"
result_json_file="$RUNNER_TEMP/cargo-deny-result.json"
manifest_list_file="$RUNNER_TEMP/cargo-deny-manifests.txt"
run_target_list_file="$RUNNER_TEMP/cargo-deny-run-targets.tsv"
run_entries_dir="$RUNNER_TEMP/cargo-deny-runs"
manifests=()
run_targets=()
if ! cargo_deny_collect_manifests "$output_file" "$@" > "$manifest_list_file"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi
mapfile -t manifests < "$manifest_list_file"
rm -f "$manifest_list_file"

workspace_root="$RUNNER_TEMP/cargo-deny-workspace"
source_root="$workspace_root/source"
image_ref=$(cargo_deny_image_ref)
user_id=$(id -u)
group_id=$(id -g)

rm -rf "$workspace_root"
mkdir -p "$workspace_root"
mkdir -p "$CARGO_HOME"
linter_lib::copy_worktree_without_git "$source_root"

cleanup_workspace() {
  rm -rf "$workspace_root"
}

trap cleanup_workspace EXIT

# shellcheck disable=SC2034 # Used indirectly via local -n in cargo_deny_collect_run_targets.
metadata_docker_run_common=(
  docker run
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --network=none
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
  --env CARGO_TERM_COLOR=never
)

cargo_deny_collect_run_targets metadata_docker_run_common "$image_ref" "${manifests[@]}" > "$run_target_list_file"
mapfile -t run_targets < "$run_target_list_file"
rm -f "$run_target_list_file"

docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
  --mount "type=bind,src=$CARGO_HOME,dst=/cargo-home"
  --mount "type=bind,src=$run_entries_dir,dst=/run-entries"
  --env CARGO_HOME=/cargo-home
  --env CARGO_TERM_COLOR=never
  --env HOME=/cargo-home
  --env PATH=/cargo-home/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
)

run_cargo_deny() {
  local failure=0
  local config_arg current_manifest current_manifest_arg config_path original_manifest
  local command_line network_safety_output run_dir run_exit run_target workdir
  local cargo_command cargo_display_command
  local run_index=0
  local field_separator=$'\x1f'

  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"

  for run_target in "${run_targets[@]}"; do
    run_index=$((run_index + 1))
    run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
    mkdir -p "$run_dir"
    IFS="$field_separator" read -r current_manifest config_path original_manifest <<< "$run_target"
    workdir=$(linter_lib::cargo_workdir_for_manifest "$original_manifest")
    current_manifest_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$original_manifest" "$current_manifest")
    if [ -n "$config_path" ]; then
      config_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$original_manifest" "$config_path")
    else
      config_arg=""
    fi

    cargo_command=(
      cargo
      deny
      --format json
      --color never
      --log-level warn
      --all-features
      --manifest-path "$current_manifest_arg"
      check
      --audit-compatible-output
    )
    if [ -n "$config_arg" ]; then
      cargo_command+=(--config "$config_arg")
    fi
    cargo_display_command=(
      cargo
      deny
      --format json
      --color never
      --log-level warn
      --all-features
      --manifest-path "$current_manifest"
      check
      --audit-compatible-output
    )
    if [ -n "$config_path" ]; then
      cargo_display_command+=(--config "$config_path")
    fi
    command_line="${cargo_display_command[*]}"
    printf '%s\n' "$command_line" > "$run_dir/command.txt"
    printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"
    printf '%s\n' "$config_path" > "$run_dir/config_path.txt"

    if ! network_safety_output=$(linter_lib::validate_network_safe_cargo_config "$original_manifest" 2>&1); then
      failure=1
      printf '%s\n' "$network_safety_output" > "$run_dir/stderr.txt"
      : > "$run_dir/stdout.txt"
      printf '1\n' > "$run_dir/exit_code.txt"
      continue
    fi

    set +e
    docker run \
      "${docker_run_common[@]}" \
      --workdir "$workdir" \
      "$image_ref" \
      "${cargo_command[@]}" >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
    run_exit=$?
    set -e

    printf '%s\n' "$run_exit" > "$run_dir/exit_code.txt"

    if [ "$run_exit" -ne 0 ]; then
      failure=1
    fi
  done

  return "$failure"
}

if run_cargo_deny; then
  exit_code=0
else
  exit_code=1
fi

node "$script_dir/cargo-deny-result.js" "$run_entries_dir" "$exit_code" > "$result_json_file"
cat "$result_json_file"
