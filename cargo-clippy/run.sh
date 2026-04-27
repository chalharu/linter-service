#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
result_json_file="$RUNNER_TEMP/cargo-clippy-result.json"
structured_runs_file="$RUNNER_TEMP/cargo-clippy-structured-runs.json"
run_entries_dir="$RUNNER_TEMP/cargo-clippy-runs"
rm -f "$result_json_file" "$structured_runs_file"
rm -rf "$run_entries_dir"
cargo_clippy_require_docker
manifests=()
run_targets=()
if ! linter_lib::collect_cargo_manifests "$output_file" "Cargo clippy" manifests "$@"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

workspace_root="$RUNNER_TEMP/cargo-clippy-workspace"
source_root="$workspace_root/source"
cargo_home="$workspace_root/cargo-home"
rustup_root="$workspace_root/rustup-home"
target_root="$workspace_root/cargo-target"
image_ref=$(cargo_clippy_image_ref)
user_id=$(id -u)
group_id=$(id -g)

rm -rf "$workspace_root"
rm -rf "$run_entries_dir"
mkdir -p "$cargo_home" "$rustup_root" "$target_root" "$run_entries_dir"
linter_lib::copy_worktree_without_git "$source_root"

cleanup_workspace() {
  rm -rf "$workspace_root"
}

trap cleanup_workspace EXIT

seed_writable_rustup_home() {
  if [ -f "$rustup_root/settings.toml" ]; then
    return 0
  fi

  printf '==> docker run seed writable rustup home\n'
  docker run \
    --rm \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp \
    --user "$user_id:$group_id" \
    --mount "type=bind,src=$rustup_root,dst=/rustup-home" \
    "$image_ref" \
    sh -ceu 'tar -C /usr/local/rustup -cf - . | tar -xf - -C /rustup-home'
  echo
}

docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
  --mount "type=bind,src=$cargo_home,dst=/cargo-home"
  --mount "type=bind,src=$rustup_root,dst=/usr/local/rustup"
  --mount "type=bind,src=$target_root,dst=/cargo-target"
  --mount "type=bind,src=$run_entries_dir,dst=/run-entries"
  --env CARGO_HOME=/cargo-home
  --env CARGO_TARGET_DIR=/cargo-target
  --env CARGO_TERM_COLOR=never
  --env HOME=/cargo-home
)

metadata_docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
)

cargo_clippy_resolve_workspace_manifest() {
  local manifest_path=$1
  local manifest_arg workdir

  manifest_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$manifest_path" "$manifest_path")
  workdir=$(linter_lib::cargo_workdir_for_manifest "$manifest_path")

  linter_lib::resolve_cargo_workspace_manifest /work "$manifest_arg" \
    docker run "${metadata_docker_run_common[@]}" --network=none --workdir "$workdir" "$image_ref" cargo
}

cargo_clippy_collect_run_targets() {
  local -A seen_targets=()
  local manifest_path normalized_manifest config_key dedupe_key

  for manifest_path in "${manifests[@]}"; do
    normalized_manifest=$(cargo_clippy_resolve_workspace_manifest "$manifest_path")
    config_key=$(linter_lib::cargo_config_chain_key "$manifest_path")
    dedupe_key="$normalized_manifest"$'\t'"$config_key"
    if [ -n "${seen_targets[$dedupe_key]+x}" ]; then
      continue
    fi

    seen_targets["$dedupe_key"]=1
    printf '%s\t%s\n' "$normalized_manifest" "$manifest_path"
  done
}

mapfile -t run_targets < <(cargo_clippy_collect_run_targets)

run_cargo_clippy() {
  local failure=0
  local current_manifest current_manifest_arg original_manifest run_target run_dir run_exit command_line
  local cargo_clippy_command cargo_clippy_display_command cargo_fetch_command network_safety_output workdir
  local run_index=0

  if ! seed_writable_rustup_home; then
    return 1
  fi

  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"

  for run_target in "${run_targets[@]}"; do
    IFS=$'\t' read -r current_manifest original_manifest <<< "$run_target"
    workdir=$(linter_lib::cargo_workdir_for_manifest "$original_manifest")
    current_manifest_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$original_manifest" "$current_manifest")

    if ! network_safety_output=$(linter_lib::validate_network_safe_cargo_config "$original_manifest" 2>&1); then
      failure=1
      printf '==> reject cargo fetch --manifest-path %s\n%s\n\n' "$current_manifest" "$network_safety_output"
      printf '==> skip cargo clippy --manifest-path %s because cargo fetch safety checks failed\n\n' "$current_manifest"
      continue
    fi

    cargo_fetch_command=(cargo fetch --manifest-path "$current_manifest_arg")
    printf '==> docker run %s\n' "${cargo_fetch_command[*]}"
    if ! docker run \
      "${docker_run_common[@]}" \
      --workdir "$workdir" \
      "$image_ref" \
      "${cargo_fetch_command[@]}"; then
      failure=1
      printf '==> skip cargo clippy --manifest-path %s because cargo fetch failed\n\n' "$current_manifest"
      continue
    fi
    echo

    run_index=$((run_index + 1))
    run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
    mkdir -p "$run_dir"
    cargo_clippy_command=(
      cargo
      clippy
      --message-format=json
      --manifest-path "$current_manifest_arg"
      --all-targets
      --
      -D warnings
    )
    cargo_clippy_display_command=(
      cargo
      clippy
      --message-format=json
      --manifest-path "$current_manifest"
      --all-targets
      --
      -D warnings
    )
    command_line="${cargo_clippy_display_command[*]}"
    printf '%s\n' "$command_line" > "$run_dir/command.txt"
    printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"
    set +e
    docker run \
      "${docker_run_common[@]}" \
      --workdir "$workdir" \
      --network=none \
      "$image_ref" \
      "${cargo_clippy_command[@]}" >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
    run_exit=$?
    set -e
    printf '%s\n' "$run_exit" > "$run_dir/exit_code.txt"
    if [ "$run_exit" -ne 0 ]; then
      failure=1
    fi
  done

  return "$failure"
}

if run_cargo_clippy >"$output_file" 2>&1; then
  exit_code=0
else
  exit_code=$?
fi

node "$script_dir/cargo-clippy-result.js" \
  "$run_entries_dir" \
  "$output_file" \
  "$exit_code" \
  "$structured_runs_file" > "$result_json_file"
cat "$result_json_file"
