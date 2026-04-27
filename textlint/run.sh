#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
textlint_require_docker
files=("$@")
temp_root="$RUNNER_TEMP/textlint"
temp_repo="$temp_root/repo"
rules_dir="$temp_root/preset"
report_path="$temp_root/report.json"
stderr_path="$temp_root/stderr.txt"
result_json_path="$RUNNER_TEMP/textlint-result.json"
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
  local -a preset_specs=()
  safe_config_path="$temp_repo/.textlintrc"

  rm -rf "$temp_repo" "$rules_dir" "$report_path" "$stderr_path"
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

  mapfile -t preset_specs < <(
    node - "$runtime_json" <<'NODE'
const runtime = JSON.parse(process.argv[2]);
for (const preset of runtime.presetPackages) {
  process.stdout.write(`${preset.spec}\n`);
}
NODE
  )

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
      --format json \
      --rules-base-directory /rules/node_modules \
      "${files[@]}" \
    >"$report_path" 2>"$stderr_path"; then
    exit_code=0
  else
    exit_code=$?
  fi

  node "$script_dir/textlint-result.js" \
    "$report_path" \
    "$stderr_path" \
    "$temp_repo" \
    "$exit_code"

  return 0
}

run_textlint "$@" >"$result_json_path"
cat "$result_json_path"
