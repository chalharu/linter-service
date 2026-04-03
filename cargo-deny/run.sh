#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_deny_prepare_env
output_file="$RUNNER_TEMP/linter-output.txt"
result_json_file="$RUNNER_TEMP/cargo-deny-result.json"
manifest_list_file="$RUNNER_TEMP/cargo-deny-manifests.txt"
run_target_list_file="$RUNNER_TEMP/cargo-deny-run-targets.tsv"
run_entries_dir="$RUNNER_TEMP/cargo-deny-runs"
manifests=()
normalized_manifests=()
declare -A seen_normalized_manifests=()
relevant_dirs=()
run_targets=()
unsupported_config=""
if ! cargo_deny_collect_manifests "$output_file" "$@" > "$manifest_list_file"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi
mapfile -t manifests < "$manifest_list_file"
rm -f "$manifest_list_file"

workspace_root="$RUNNER_TEMP/cargo-deny-workspace"
source_root="$workspace_root/source"

rm -rf "$workspace_root"
mkdir -p "$workspace_root"
linter_lib::copy_worktree_without_git "$source_root"

cleanup_workspace() {
  rm -rf "$workspace_root"
}

trap cleanup_workspace EXIT

cargo_deny_collect_run_targets "$source_root" "${manifests[@]}" > "$run_target_list_file"
mapfile -t run_targets < "$run_target_list_file"
rm -f "$run_target_list_file"

for run_target in "${run_targets[@]}"; do
  IFS=$'\t' read -r current_manifest _ <<< "$run_target"
  if [ -z "${seen_normalized_manifests[$current_manifest]+x}" ]; then
    seen_normalized_manifests["$current_manifest"]=1
    normalized_manifests+=("$current_manifest")
  fi
done

mapfile -t relevant_dirs < <(linter_lib::collect_cargo_relevant_dirs "${normalized_manifests[@]}")
if unsupported_config="$(linter_lib::find_unsupported_cargo_config "${relevant_dirs[@]}")"; then
  cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo metadata\` / \`cargo deny check\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-deny\` path.
EOF
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

run_cargo_deny() {
  local failure=0
  local current_manifest config_path command_line run_dir run_exit run_target
  local run_index=0

  cd "$source_root"
  export HOME="$CARGO_HOME"
  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"

  for run_target in "${run_targets[@]}"; do
    run_index=$((run_index + 1))
    run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
    mkdir -p "$run_dir"
    IFS=$'\t' read -r current_manifest config_path <<< "$run_target"

    if [ -n "$config_path" ]; then
      command_line="cargo-deny --format json --color never --log-level warn --all-features --manifest-path $current_manifest check --audit-compatible-output --config $config_path"
      set +e
      cargo-deny \
        --format json \
        --color never \
        --log-level warn \
        --all-features \
        --manifest-path "$current_manifest" \
        check \
        --audit-compatible-output \
        --config "$config_path" >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
      run_exit=$?
      set -e
    else
      command_line="cargo-deny --format json --color never --log-level warn --all-features --manifest-path $current_manifest check --audit-compatible-output"
      set +e
      cargo-deny \
        --format json \
        --color never \
        --log-level warn \
        --all-features \
        --manifest-path "$current_manifest" \
        check \
        --audit-compatible-output >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
      run_exit=$?
      set -e
    fi

    printf '%s\n' "$command_line" > "$run_dir/command.txt"
    printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"
    printf '%s\n' "$config_path" > "$run_dir/config_path.txt"
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
