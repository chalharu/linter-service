#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
result_json_file="$RUNNER_TEMP/cargo-symbol-length-result.json"
config_json_file="$RUNNER_TEMP/cargo-symbol-length-config.json"
run_entries_dir="$RUNNER_TEMP/cargo-symbol-length-runs"
rm -f "$result_json_file" "$config_json_file"
rm -rf "$run_entries_dir"
cargo_symbol_length_require_docker
manifests=()
normalized_manifests=()
relevant_dirs=()
unsupported_config=""

if ! linter_lib::collect_cargo_manifests "$output_file" "cargo-symbol-length" manifests "$@"; then
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

mapfile -t relevant_dirs < <(linter_lib::collect_cargo_relevant_dirs "${manifests[@]}")
if unsupported_config="$(linter_lib::find_unsupported_cargo_config "${relevant_dirs[@]}")"; then
  cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo fetch\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-symbol-length\` path.
EOF
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

workspace_root="$RUNNER_TEMP/cargo-symbol-length-workspace"
source_root="$workspace_root/source"
cargo_home="$workspace_root/cargo-home"
rustup_root="$workspace_root/rustup-home"
target_root="$workspace_root/cargo-target"
image_ref=$(cargo_symbol_length_image_ref)
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

metadata_docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --workdir /work
  --mount "type=bind,src=$source_root,dst=/work"
)

cargo_symbol_length_resolve_workspace_manifest() {
  local manifest_path=$1

  linter_lib::resolve_cargo_workspace_manifest /work "$manifest_path" \
    docker run "${metadata_docker_run_common[@]}" --network=none "$image_ref" cargo
}

cargo_symbol_length_normalize_manifests() {
  local -A seen_manifests=()
  local manifest_path normalized_manifest

  for manifest_path in "${manifests[@]}"; do
    normalized_manifest=$(cargo_symbol_length_resolve_workspace_manifest "$manifest_path")
    if [ -n "${seen_manifests[$normalized_manifest]+x}" ]; then
      continue
    fi

    seen_manifests["$normalized_manifest"]=1
    printf '%s\n' "$normalized_manifest"
  done
}

mapfile -t normalized_manifests < <(cargo_symbol_length_normalize_manifests)

docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
  --workdir /work
  --mount "type=bind,src=$source_root,dst=/work"
  --mount "type=bind,src=$cargo_home,dst=/cargo-home"
  --mount "type=bind,src=$rustup_root,dst=/usr/local/rustup"
  --mount "type=bind,src=$target_root,dst=/cargo-target"
  --mount "type=bind,src=$run_entries_dir,dst=/run-entries"
  --mount "type=bind,src=$script_dir/scan.py,dst=/linter/scan.py,readonly"
  --env CARGO_HOME=/cargo-home
  --env CARGO_TARGET_DIR=/cargo-target
  --env CARGO_TERM_COLOR=never
  --env HOME=/cargo-home
)

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

run_cargo_symbol_length() {
  local failure=0
  local current_manifest
  local fetch_failures_path="$cargo_home/fetch-failed-manifests.txt"
  local scan_manifests=()
  local -A failed_fetches=()

  if ! seed_writable_rustup_home; then
    return 1
  fi

  rm -rf "$run_entries_dir"
  mkdir -p "$run_entries_dir"
  rm -f "$fetch_failures_path"

  if ! docker run \
    "${docker_run_common[@]}" \
    --env LINTER_SERVICE_BATCH_MODE=fetch \
    "$image_ref" \
    sh -ceu '
      failed_path=/cargo-home/fetch-failed-manifests.txt
      : > "$failed_path"
      for manifest_path in "$@"; do
        printf "==> docker run cargo fetch --manifest-path %s\n" "$manifest_path"
        if ! cargo fetch --manifest-path "$manifest_path"; then
          printf "%s\n" "$manifest_path" >> "$failed_path"
        fi
        echo
      done
    ' sh "${normalized_manifests[@]}"; then
    return 1
  fi

  if [ -s "$fetch_failures_path" ]; then
    failure=1
    while IFS= read -r current_manifest; do
      if [ -n "$current_manifest" ]; then
        failed_fetches["$current_manifest"]=1
      fi
    done < "$fetch_failures_path"
  fi

  for current_manifest in "${normalized_manifests[@]}"; do
    if [ -n "${failed_fetches[$current_manifest]+x}" ]; then
      printf '==> skip cargo-symbol-length --manifest-path %s because cargo fetch failed\n\n' "$current_manifest"
      continue
    fi
    scan_manifests+=("$current_manifest")
  done

  if [ "${#scan_manifests[@]}" -eq 0 ]; then
    return "$failure"
  fi

  if ! docker run \
    "${docker_run_common[@]}" \
    --network=none \
    "$image_ref" \
    python3 /linter/scan.py "${scan_manifests[@]}"; then
    failure=1
  fi

  return "$failure"
}

set +e
run_cargo_symbol_length >"$output_file" 2>&1
exit_code=$?
set -e

node "$script_dir/load-config.js" "$PWD" > "$config_json_file"

node "$script_dir/cargo-symbol-length-result.js" \
  "$run_entries_dir" \
  "$output_file" \
  "$config_json_file" \
  "$exit_code" > "$result_json_file"
cat "$result_json_file"
