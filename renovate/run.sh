#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
renovate_require_container_runtime
output_file="$RUNNER_TEMP/linter-output.txt"
raw_output_file="$RUNNER_TEMP/renovate-raw-output.txt"
normalized_output_file="$RUNNER_TEMP/renovate-normalized-output.txt"
temp_root="$RUNNER_TEMP/renovate"
combined_output_file="$RUNNER_TEMP/renovate-combined-output.txt"
container_bin=$(renovate_container_bin)
image_ref=$(renovate_image_ref)
user_id=$(id -u)
group_id=$(id -g)
declare -a config_paths=()
declare -A seen_config_paths=()
run_index=0

docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --network=none
  --user "$user_id:$group_id"
  --workdir /work
  --mount "type=bind,src=$PWD,dst=/work,readonly"
)

if [ "$#" -gt 0 ]; then
  for config_path in "$@"; do
    if ! renovate::is_supported_config_path "$config_path"; then
      echo "Unsupported Renovate config path: $config_path" >&2
      exit 1
    fi

    if [ ! -f "$config_path" ]; then
      echo "Selected Renovate config file does not exist: $config_path" >&2
      exit 1
    fi

    if [ -n "${seen_config_paths[$config_path]+x}" ]; then
      continue
    fi

    seen_config_paths["$config_path"]=1
    config_paths+=("$config_path")
  done
else
  config_paths=("$(renovate::resolve_config_path)")
fi

rm -rf "$temp_root"
mkdir -p "$temp_root"
: >"$combined_output_file"

normalize_output() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");

const [inputPath, outputPath] = process.argv.slice(2);
const source = fs.existsSync(inputPath)
  ? fs.readFileSync(inputPath, "utf8")
  : "";
const lines = source
  .split(/\r?\n/u)
  .map((line) => line.replace(/\\n\s+at .*$/u, ""))
  .filter((line) => !line.trimStart().startsWith('"stack":'));

for (let index = 0; index < lines.length - 1; index += 1) {
  if (lines[index].trimEnd().endsWith(",") && lines[index + 1].trim() === "}") {
    lines[index] = lines[index].replace(/,\s*$/u, "");
  }
}

const normalized = lines.join("\n").trim();

if (normalized.length === 0) {
  fs.rmSync(outputPath, { force: true });
  process.exit(0);
}

fs.writeFileSync(outputPath, `${normalized}\n`, "utf8");
NODE
}

overall_exit_code=0

for config_path in "${config_paths[@]}"; do
  run_root="$temp_root/run-$run_index"
  base_dir="$run_root/base-dir"
  home_dir="$run_root/home"
  rm -rf "$run_root"
  mkdir -p "$base_dir" "$home_dir"

  set +e
  "$container_bin" run \
    "${docker_run_common[@]}" \
    --mount "type=bind,src=$run_root,dst=/state" \
    --env HOME=/state/home \
    --env LOG_LEVEL=error \
    --env RENOVATE_BASE_DIR=/state/base-dir \
    --env RENOVATE_CONFIG_FILE="$config_path" \
    "$image_ref" \
    renovate \
      --platform=local \
      --dry-run=extract >"$raw_output_file" 2>&1
  exit_code=$?
  set -e

  if [ "$overall_exit_code" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
    overall_exit_code=$exit_code
  fi

  normalize_output "$raw_output_file" "$normalized_output_file"

  if [ -f "$normalized_output_file" ]; then
    if [ -s "$combined_output_file" ]; then
      printf '\n' >>"$combined_output_file"
    fi

    cat "$normalized_output_file" >>"$combined_output_file"
    printf 'config: %s\n' "$config_path" >>"$combined_output_file"
  fi

  run_index=$((run_index + 1))
done

if [ -s "$combined_output_file" ]; then
  mv "$combined_output_file" "$output_file"
else
  rm -f "$combined_output_file" "$output_file"
fi

linter_lib::emit_json_result "$overall_exit_code" "$output_file"
