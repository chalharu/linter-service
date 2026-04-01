#!/usr/bin/env bash

linter_lib::add_path() {
  local path_entry=$1

  mkdir -p "$path_entry"
  if [ -n "${GITHUB_PATH:-}" ]; then
    printf '%s\n' "$path_entry" >> "$GITHUB_PATH"
  else
    export PATH="$path_entry:$PATH"
  fi
}

linter_lib::python_cmd() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' python3
    return 0
  fi

  if command -v python >/dev/null 2>&1; then
    printf '%s\n' python
    return 0
  fi

  echo "python3 or python is required" >&2
  return 1
}

linter_lib::copy_first_existing_path() {
  local target_root=$1
  shift

  local candidate
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      local destination="$target_root/$candidate"
      mkdir -p "$(dirname "$destination")"
      cp "$candidate" "$destination"
      return 0
    fi
  done

  return 1
}

linter_lib::copy_paths_to_root() {
  local target_root=$1
  shift

  local path
  for path in "$@"; do
    local destination="$target_root/$path"
    mkdir -p "$(dirname "$destination")"
    cp "$path" "$destination"
  done
}

linter_lib::copy_worktree_without_git() {
  local target_root=$1
  local source_root=${2:-.}

  rm -rf "$target_root"
  mkdir -p "$target_root"
  tar --exclude=.git -C "$source_root" -cf - . | tar -xf - -C "$target_root"
}

linter_lib::find_cargo_manifest() {
  local path=$1
  local current_dir candidate

  current_dir=$(dirname "$path")
  while :; do
    candidate="$current_dir/Cargo.toml"
    if [ -f "$candidate" ]; then
      printf '%s\n' "${candidate#./}"
      return 0
    fi

    if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
      break
    fi

    current_dir=$(dirname "$current_dir")
  done

  return 1
}

linter_lib::collect_cargo_manifests() {
  local output_file=$1
  local tool_name=$2
  local manifests_var=$3
  shift 3

  local -n manifests_ref="$manifests_var"
  local -A seen_manifests=()
  local missing_files=()
  local path manifest_path

  manifests_ref=()

  for path in "$@"; do
    if ! manifest_path=$(linter_lib::find_cargo_manifest "$path"); then
      missing_files+=("$path")
      continue
    fi

    if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
      seen_manifests["$manifest_path"]=1
      manifests_ref+=("$manifest_path")
    fi
  done

  if [ "${#missing_files[@]}" -gt 0 ]; then
    {
      printf '%s requires each selected Rust file to belong to a Cargo package.\n' "$tool_name"
      echo "No Cargo.toml found for:"
      for path in "${missing_files[@]}"; do
        printf ' - %s\n' "$path"
      done
    } > "$output_file"
    return 1
  fi

  return 0
}

linter_lib::emit_json_result() {
  local exit_code=$1
  local output_file=$2
  local python_bin

  python_bin=$(linter_lib::python_cmd)

  "$python_bin" - "$exit_code" "$output_file" <<'PY'
import json
import sys
from pathlib import Path

exit_code = int(sys.argv[1])
output_path = Path(sys.argv[2])
details = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
print(json.dumps({"details": details, "exit_code": exit_code}))
PY
}

linter_lib::run_and_emit_json() {
  local output_file=$1
  shift
  local exit_code

  set +e
  "$@" >"$output_file" 2>&1
  exit_code=$?
  set -e

  linter_lib::emit_json_result "$exit_code" "$output_file"
}

linter_lib::install_node_tools() {
  local prefix_dir=$1
  shift

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install Node.js-based linters" >&2
    return 1
  fi

  mkdir -p "$prefix_dir"
  npm install --global --prefix "$prefix_dir" "$@" >/dev/null
  linter_lib::add_path "$prefix_dir/bin"
}

linter_lib::install_python_tools() {
  local venv_dir=$1
  shift
  local python_bin

  python_bin=$(linter_lib::python_cmd)

  "$python_bin" -m venv "$venv_dir"
  "$venv_dir/bin/pip" install --disable-pip-version-check --upgrade pip "$@" >/dev/null
  linter_lib::add_path "$venv_dir/bin"
}
