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

linter_lib::resolve_latest_github_release_tag() {
  local owner=$1
  local repo=$2
  local release_url version

  release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$owner/$repo/releases/latest")"
  version="${release_url##*/}"

  if [[ ! "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$ ]]; then
    printf 'Refusing unexpected release tag for %s/%s: %s\n' "$owner" "$repo" "$version" >&2
    return 1
  fi

  printf '%s\n' "$version"
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

linter_lib::workspace_manifest_from_metadata() {
  local source_root=$1

  node -e '
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));

if (typeof data.workspace_root !== "string" || data.workspace_root.length === 0) {
  process.exit(1);
}

const manifestPath = path.join(data.workspace_root, "Cargo.toml");
const relativePath = path.relative(sourceRoot, manifestPath);

if (relativePath.length === 0) {
  process.stdout.write("Cargo.toml");
  process.exit(0);
}

if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
  process.exit(1);
}

process.stdout.write(relativePath.split(path.sep).join("/"));
  ' "$source_root"
}

linter_lib::resolve_cargo_workspace_manifest() {
  local source_root=$1
  local manifest_path=$2
  shift 2

  local metadata_json relative_manifest

  if ! metadata_json="$("$@" metadata --format-version 1 --no-deps --manifest-path "$manifest_path" 2>/dev/null)"; then
    printf '%s\n' "$manifest_path"
    return 0
  fi

  if ! relative_manifest="$(
    printf '%s' "$metadata_json" | linter_lib::workspace_manifest_from_metadata "$source_root"
  )"; then
    printf '%s\n' "$manifest_path"
    return 0
  fi

  printf '%s\n' "$relative_manifest"
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
      printf '%s requires each selected file to belong to a Cargo package.\n' "$tool_name"
      echo "No Cargo.toml found for:"
      for path in "${missing_files[@]}"; do
        printf ' - %s\n' "$path"
      done
    } > "$output_file"
    return 1
  fi

  return 0
}

linter_lib::collect_cargo_relevant_dirs() {
  local -A seen=()
  local manifest_path current_dir

  seen["."]=1
  printf '%s\n' "."

  for manifest_path in "$@"; do
    current_dir=$(dirname "$manifest_path")

    while :; do
      if [ -z "${seen[$current_dir]+x}" ]; then
        seen["$current_dir"]=1
        printf '%s\n' "$current_dir"
      fi

      if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
        break
      fi

      current_dir=$(dirname "$current_dir")
    done
  done
}

linter_lib::find_unsupported_cargo_config() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.cargo/config.toml" \
      "$dir/.cargo/config"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
        return 0
      fi
    done
  done

  return 1
}

linter_lib::emit_json_result() {
  local exit_code=$1
  local output_file=$2
  local python_bin

  if python_bin="$(linter_lib::python_cmd 2>/dev/null)"; then
    "$python_bin" - "$exit_code" "$output_file" <<'PY'
import json
import sys
from pathlib import Path

exit_code = int(sys.argv[1])
output_path = Path(sys.argv[2])
details = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
print(json.dumps({"details": details, "exit_code": exit_code}))
PY
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");

const [exitCodeRaw, outputPath] = process.argv.slice(2);
const details =
  outputPath && fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8").trim()
    : "";
process.stdout.write(
  JSON.stringify({
    details,
    exit_code: Number.parseInt(exitCodeRaw, 10),
  }),
);
NODE
    return 0
  fi

  echo "python3, python, or node is required" >&2
  return 1
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
