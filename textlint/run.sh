#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
textlint_require_docker
output_file="$RUNNER_TEMP/linter-output.txt"
files=("$@")
temp_root="$RUNNER_TEMP/textlint"
temp_repo="$temp_root/repo"
rules_dir="$temp_root/preset"
raw_output_path="$temp_root/raw-output.txt"
container_bin=$(textlint_container_bin)
image_ref=$(textlint_image_ref)
user_id=$(id -u)
group_id=$(id -g)

docker_run_common=(
  --rm
  --cap-drop ALL
  --security-opt no-new-privileges
  --read-only
  --tmpfs /tmp
  --user "$user_id:$group_id"
)

install_textlint_presets() {
  local min_release_age_days=$1
  shift

  "$container_bin" run \
    "${docker_run_common[@]}" \
    --workdir /rules \
    --mount "type=bind,src=$rules_dir,dst=/rules" \
    --env HOME=/tmp \
    --env npm_config_cache=/tmp/npm-cache \
    "$image_ref" \
    npm install \
      --prefix /rules \
      --ignore-scripts \
      --loglevel=error \
      --no-audit \
      --no-fund \
      --no-save \
      --package-lock=false \
      --update-notifier=false \
      --min-release-age "$min_release_age_days" \
      "$@"
}

run_textlint() {
  local exit_code min_release_age_days path runtime_json safe_config_path
  local -a preset_args=()
  local -a preset_names=()
  local -a preset_specs=()
  safe_config_path="$temp_repo/.textlintrc"

  rm -rf "$temp_repo" "$rules_dir" "$raw_output_path"
  mkdir -p "$temp_repo" "$rules_dir"

  runtime_json="$(
    node - "$script_dir/textlint-config.js" "$PWD" "$safe_config_path" <<'NODE'
const [helperPath, repositoryPath, outputPath] = process.argv.slice(2);
const { resolveTextlintRuntime } = require(helperPath);
process.stdout.write(
  JSON.stringify(
    resolveTextlintRuntime({
      outputPath,
      repositoryPath,
    }),
  ),
);
NODE
  )"

  mapfile -t preset_names < <(
    node - "$runtime_json" <<'NODE'
const runtime = JSON.parse(process.argv[2]);
for (const preset of runtime.presetPackages) {
  process.stdout.write(`${preset.name}\n`);
}
NODE
  )
  mapfile -t preset_specs < <(
    node - "$runtime_json" <<'NODE'
const runtime = JSON.parse(process.argv[2]);
for (const preset of runtime.presetPackages) {
  process.stdout.write(`${preset.spec}\n`);
}
NODE
  )

  for path in "${preset_names[@]}"; do
    preset_args+=(--preset "$path")
  done

  min_release_age_days=$(textlint_npm_min_release_age_days)
  install_textlint_presets "$min_release_age_days" "${preset_specs[@]}" >/dev/null

  linter_lib::copy_paths_to_root "$temp_repo" "${files[@]}"

  for path in "${files[@]}"; do
    if [ ! -f "$temp_repo/$path" ]; then
      echo "failed to prepare textlint target: $path" >&2
      return 1
    fi
  done

  if "$container_bin" run \
    "${docker_run_common[@]}" \
    --network=none \
    --workdir /work \
    --mount "type=bind,src=$temp_repo,dst=/work,readonly" \
    --mount "type=bind,src=$rules_dir,dst=/rules,readonly" \
    --env HOME=/tmp \
    "$image_ref" \
    textlint \
      --config .textlintrc \
      --format unix \
      --no-color \
      "${preset_args[@]}" \
      --rules-base-directory /rules/node_modules \
      "${files[@]}" \
    >"$raw_output_path" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  node - "$raw_output_path" "$temp_repo" <<'NODE'
const fs = require("node:fs");

const [outputPath, tempRepo] = process.argv.slice(2);
const source = fs.existsSync(outputPath)
  ? fs.readFileSync(outputPath, "utf8")
  : "";
const prefixes = [
  `${tempRepo.replace(/\\/gu, "/").replace(/\/$/u, "")}/`,
  "/work/",
];

let normalized = source;
for (const prefix of prefixes) {
  normalized = normalized.split(prefix).join("");
}

process.stdout.write(normalized);
NODE

  return "$exit_code"
}

linter_lib::run_and_emit_json "$output_file" run_textlint
