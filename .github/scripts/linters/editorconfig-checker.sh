#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

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

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    pattern='^(?!.*(?:^|/)(?:\.git|\.jj|node_modules|target|\.yarn)(?:/|$))'
    pattern+='(?!.*(?:^|/)(?:Cargo\.lock|composer\.lock|Gemfile\.lock|Pipfile\.lock|'
    pattern+='npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|poetry\.lock|'
    pattern+='uv\.lock|yarn\.lock|go\.(?:mod|sum|work|work\.sum)|'
    pattern+='gradle/wrapper/gradle-wrapper\.properties|gradlew(?:\.bat)?|'
    pattern+='(?:buildscript-)?gradle\.lockfile?|'
    pattern+='\.mvn/wrapper/maven-wrapper\.properties|'
    pattern+='\.mvn/wrapper/MavenWrapperDownloader\.java|mvnw(?:\.cmd)?|'
    pattern+='\.terraform\.lock\.hcl|\.pnp\.c?js|\.pnp\.loader\.mjs)$)'
    pattern+='(?!.*\.(?:7z|avif|bak|bin|bz2|docx?|eot|exe|gif|gz|ico|jar|jpe?g|log|'
    pattern+='mp4|otf|p[bgnp]m|patch|pdf|png|snap|svg|tar|tgz|tiff?|ttf|war|webp|'
    pattern+='wmv|woff2?|xlsx?|zip)$)'
    pattern+='(?!.*\.(?:css|js)\.map$)(?!.*min\.(?:css|js)$).+'
    printf '%s\n' "$pattern"
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

    if command -v editorconfig-checker >/dev/null 2>&1 && editorconfig-checker -version >/dev/null 2>&1; then
      exit 0
    fi

    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/editorconfig-checker/editorconfig-checker/releases/latest)"
    version="$(basename "$release_url")"
    asset="ec-linux-amd64.tar.gz"
    archive_path="$RUNNER_TEMP/$asset"
    extract_dir="$RUNNER_TEMP/editorconfig-checker-extract"
    bin_dir="$RUNNER_TEMP/editorconfig-checker/bin"

    rm -rf "$extract_dir" "$bin_dir"
    mkdir -p "$extract_dir" "$bin_dir"

    curl -fsSL "https://github.com/editorconfig-checker/editorconfig-checker/releases/download/$version/$asset" -o "$archive_path"
    tar -xzf "$archive_path" -C "$extract_dir"
    cp "$extract_dir/bin/ec-linux-amd64" "$bin_dir/editorconfig-checker"
    chmod +x "$bin_dir/editorconfig-checker"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    temp_repo="$RUNNER_TEMP/editorconfig-checker-repo"
    temp_config="$temp_repo/.editorconfig-checker.shared.json"
    files=("$@")
    relevant_dirs=()
    editorconfig_files=()
    base_config=""

    rm -rf "$temp_repo"
    mkdir -p "$temp_repo"

    linter_lib::copy_paths_to_root "$temp_repo" "${files[@]}"
    mapfile -t relevant_dirs < <(editorconfig_collect_relevant_dirs "${files[@]}")
    mapfile -t editorconfig_files < <(editorconfig_collect_editorconfig_files "${relevant_dirs[@]}")

    if [ "${#editorconfig_files[@]}" -gt 0 ]; then
      linter_lib::copy_paths_to_root "$temp_repo" "${editorconfig_files[@]}"
    fi

    if resolved_config="$(editorconfig_resolve_repo_config)"; then
      base_config="$resolved_config"
    fi

    run_editorconfig_checker() {
      editorconfig_write_temp_config "$temp_config" "$base_config" "${files[@]}"
      cd "$temp_repo" || exit 1
      editorconfig-checker -config .editorconfig-checker.shared.json
    }

    linter_lib::run_and_emit_json "$output_file" run_editorconfig_checker
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
