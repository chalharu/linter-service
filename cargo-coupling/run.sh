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
relevant_dirs=()
unsupported_config=""

rm -f "$output_file" "$result_json_file" "$config_json_file" "$manifest_list_file"
rm -rf "$run_entries_dir"

cargo_coupling_require_container_runtime
container_bin=$(cargo_coupling_container_bin)
image_ref=$(cargo_coupling_image_ref)

if ! linter_lib::collect_cargo_manifests "$output_file" "Cargo coupling" manifests "$@"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

mapfile -t relevant_dirs < <(linter_lib::collect_cargo_relevant_dirs "${manifests[@]}")
if unsupported_config="$(linter_lib::find_unsupported_cargo_config "${relevant_dirs[@]}")"; then
  cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo metadata\` / \`cargo-coupling\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-coupling\` path.
EOF
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

workspace_root="$RUNNER_TEMP/cargo-coupling-workspace"
source_root="$workspace_root/source"
user_id=$(id -u)
group_id=$(id -g)

rm -rf "$workspace_root"
mkdir -p "$workspace_root" "$run_entries_dir"
linter_lib::copy_worktree_without_git "$source_root"

cleanup_workspace() {
  rm -rf "$workspace_root"
}

trap cleanup_workspace EXIT

node "$script_dir/load-config.js" "$PWD" > "$config_json_file"

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

run_cargo_coupling() {
  local failure=0
  local current_manifest analysis_path run_dir run_exit command_line stdout_file stderr_file
  local run_index=0

  cd "$source_root"
  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"

  for current_manifest in "${deduped_manifests[@]}"; do
    run_index=$((run_index + 1))
    run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
    mkdir -p "$run_dir"
    analysis_path=$(cargo_coupling_analysis_path_for_manifest "$current_manifest")
    stdout_file="$run_dir/stdout.txt"
    stderr_file="$run_dir/stderr.txt"
    command_line="docker run cargo-coupling coupling --json --no-git $analysis_path"

    set +e
    "$container_bin" run \
      --rm \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --network=none \
      --read-only \
      --tmpfs /tmp \
      --user "$user_id:$group_id" \
      --workdir /work \
      --mount "type=bind,src=$source_root,dst=/work" \
      --env HOME=/tmp \
      "$image_ref" \
      coupling \
      --json \
      --no-git \
      "$analysis_path" >"$stdout_file" 2>"$stderr_file"
    run_exit=$?
    set -e

    printf '%s\n' "$analysis_path" > "$run_dir/analysis_path.txt"
    printf '%s\n' "$command_line" > "$run_dir/command.txt"
    printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"
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
