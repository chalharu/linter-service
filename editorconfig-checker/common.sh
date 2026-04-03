#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

editorconfig_collect_relevant_dirs() {
  local -A seen=()
  local path current_dir

  seen["."]=1
  printf '%s\n' "."

  for path in "$@"; do
    current_dir=$(dirname "$path")

    while :; do
      if [ -z "${seen[$current_dir]+x}" ]; then
        seen["$current_dir"]=1
        printf '%s\n' "$current_dir"
      fi

      if [ "$current_dir" = "." ]; then
        break
      fi

      current_dir=$(dirname "$current_dir")
    done
  done
}

editorconfig_collect_editorconfig_files() {
  local dir candidate

  for dir in "$@"; do
    candidate="$dir/.editorconfig"
    if [ -f "$candidate" ]; then
      printf '%s\n' "${candidate#./}"
    fi
  done
}

editorconfig_resolve_repo_config() {
  if [ -f .editorconfig-checker.json ]; then
    printf '%s\n' .editorconfig-checker.json
    return 0
  fi

  if [ -f .ecrc ]; then
    printf '%s\n' .ecrc
    return 0
  fi

  return 1
}

editorconfig_write_temp_config() {
  local output_path=$1
  local base_config_path=${2-}
  shift 2

  node - "$output_path" "$base_config_path" "$@" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [, , outputPath, baseConfigPath, ...passedFiles] = process.argv;
let config = {};

  if (baseConfigPath && fs.existsSync(baseConfigPath)) {
    config = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
    if (config === null || Array.isArray(config) || typeof config !== "object") {
      throw new Error("editorconfig-checker config must be a JSON object");
    }
  }

  delete config.Version;
  config.PassedFiles = passedFiles;
  config.NoColor = true;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}
