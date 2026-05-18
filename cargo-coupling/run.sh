#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
result_json_file="$RUNNER_TEMP/cargo-coupling-result.json"
config_json_file="$RUNNER_TEMP/cargo-coupling-config.json"
manifest_list_file="$RUNNER_TEMP/cargo-coupling-manifests.txt"
run_entries_dir="$RUNNER_TEMP/cargo-coupling-runs"
manifests=()
deduped_manifests=()

rm -f "$output_file" "$result_json_file" "$config_json_file" "$manifest_list_file"
rm -rf "$run_entries_dir"

cargo_coupling_require_container_runtime
container_bin=$(cargo_coupling_container_bin)
image_ref=$(cargo_coupling_image_ref)

if ! linter_lib::collect_cargo_manifests "$output_file" "Cargo coupling" manifests "$@"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

workspace_root="$RUNNER_TEMP/cargo-coupling-workspace"
source_root="$workspace_root/source"
cargo_home="$workspace_root/cargo-home"
rustup_root="$workspace_root/rustup-home"
user_id=$(id -u)
group_id=$(id -g)

rm -rf "$workspace_root"
mkdir -p "$source_root" "$cargo_home" "$rustup_root" "$run_entries_dir"
linter_lib::copy_worktree_without_git "$source_root"

cleanup_workspace() {
  rm -rf "$workspace_root"
}

trap cleanup_workspace EXIT

node "$script_dir/load-config.js" "$PWD" > "$config_json_file"

metadata_container_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
)

container_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --mount "type=bind,src=$source_root,dst=/work"
  --mount "type=bind,src=$cargo_home,dst=/cargo-home"
  --mount "type=bind,src=$rustup_root,dst=/usr/local/rustup"
  --env CARGO_HOME=/cargo-home
  --env CARGO_TERM_COLOR=never
  --env HOME=/cargo-home
)

cargo_coupling_dedupe_manifests() {
  local -A seen_manifests=()
  local manifest_path

  for manifest_path in "${manifests[@]}"; do
    if [ -n "${seen_manifests[$manifest_path]+x}" ]; then
      continue
    fi

    seen_manifests["$manifest_path"]=1
    printf '%s\n' "$manifest_path"
  done
}

mapfile -t deduped_manifests < <(cargo_coupling_dedupe_manifests)

seed_writable_rustup_home() {
  if [ -f "$rustup_root/settings.toml" ]; then
    return 0
  fi

  "$container_bin" run \
    --rm \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp \
    --user "$user_id:$group_id" \
    --mount "type=bind,src=$rustup_root,dst=/rustup-home" \
    --entrypoint sh \
    "$image_ref" \
    -ceu 'tar -C /usr/local/rustup -cf - . | tar -xf - -C /rustup-home'
}

cargo_coupling_resolve_workspace_manifest() {
  local manifest_path=$1
  local manifest_arg workdir

  manifest_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$manifest_path" "$manifest_path")
  workdir=$(cargo_coupling_workdir_for_manifest "$manifest_path")

  linter_lib::resolve_cargo_workspace_manifest /work "$manifest_arg" \
    "$container_bin" run "${metadata_container_run_common[@]}" --network=none --entrypoint cargo --workdir "$workdir" "$image_ref"
}

run_cargo_coupling() {
  local failure=0
  local current_manifest analysis_path workdir run_dir run_exit command_line stdout_file stderr_file
  local fetch_manifest fetch_manifest_arg fetch_display_command fetch_command network_safety_output fetch_stdout_file fetch_stderr_file
  local run_index=0

  if ! seed_writable_rustup_home; then
    return 1
  fi

  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"

  for current_manifest in "${deduped_manifests[@]}"; do
    analysis_path=$(cargo_coupling_analysis_path_for_manifest "$current_manifest")
    workdir=$(cargo_coupling_workdir_for_manifest "$current_manifest")
    fetch_manifest=$(cargo_coupling_resolve_workspace_manifest "$current_manifest")
    fetch_manifest_arg=$(linter_lib::relative_repo_path_from_manifest_dir "$current_manifest" "$fetch_manifest")
    fetch_display_command="cargo fetch --manifest-path $fetch_manifest"

    run_index=$((run_index + 1))
    run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
    mkdir -p "$run_dir"
    stdout_file="$run_dir/stdout.txt"
    stderr_file="$run_dir/stderr.txt"
    fetch_stdout_file="$run_dir/fetch-stdout.txt"
    fetch_stderr_file="$run_dir/fetch-stderr.txt"

    printf '%s\n' "$analysis_path" > "$run_dir/analysis_path.txt"
    printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"

    if ! network_safety_output=$(linter_lib::validate_network_safe_cargo_config "$current_manifest" 2>&1); then
      failure=1
      printf '%s\n' "$fetch_display_command" > "$run_dir/command.txt"
      printf '%s\n' 1 > "$run_dir/exit_code.txt"
      printf 'reject cargo fetch --manifest-path %s\n%s\n\nskip cargo-coupling --manifest-path %s because cargo fetch safety checks failed\n' \
        "$fetch_manifest" \
        "$network_safety_output" \
        "$current_manifest" > "$stderr_file"
      continue
    fi

    fetch_command=(fetch --manifest-path "$fetch_manifest_arg")
    set +e
    "$container_bin" run \
      "${container_run_common[@]}" \
      --entrypoint cargo \
      --workdir "$workdir" \
      "$image_ref" \
      "${fetch_command[@]}" >"$fetch_stdout_file" 2>"$fetch_stderr_file"
    run_exit=$?
    set -e

    if [ "$run_exit" -ne 0 ]; then
      failure=1
      printf '%s\n' "$fetch_display_command" > "$run_dir/command.txt"
      printf '%s\n' "$run_exit" > "$run_dir/exit_code.txt"
      cat "$fetch_stdout_file" > "$stdout_file"
      {
        cat "$fetch_stderr_file"
        printf '\nskip cargo-coupling --manifest-path %s because cargo fetch failed\n' "$current_manifest"
      } > "$stderr_file"
      continue
    fi

    rm -f "$fetch_stdout_file" "$fetch_stderr_file"
    command_line="docker run cargo-coupling coupling --json --no-git $analysis_path"
    printf '%s\n' "$command_line" > "$run_dir/command.txt"
    set +e
    "$container_bin" run \
      "${container_run_common[@]}" \
      --network=none \
      --workdir "$workdir" \
      --env CARGO_NET_OFFLINE=true \
      "$image_ref" \
      coupling \
      --json \
      --no-git \
      "$analysis_path" >"$stdout_file" 2>"$stderr_file"
    run_exit=$?
    set -e

    printf '%s\n' "$run_exit" > "$run_dir/exit_code.txt"

    if [ "$run_exit" -ne 0 ]; then
      failure=1
    fi
  done

  return "$failure"
}

if run_cargo_coupling; then
  command_exit_code=0
else
  command_exit_code=1
fi

node "$script_dir/cargo-coupling-result.js" \
  "$run_entries_dir" \
  "$config_json_file" \
  "$command_exit_code" > "$result_json_file"
cat "$result_json_file"
