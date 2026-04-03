#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
temp_repo="$RUNNER_TEMP/markdownlint-cli2-repo"
files=("$@")
literal_paths=()
safe_configs=()
relevant_dirs=()
unsafe_config=""

rm -rf "$temp_repo"
mkdir -p "$temp_repo"

linter_lib::copy_paths_to_root "$temp_repo" "${files[@]}"

mapfile -t relevant_dirs < <(markdownlint_collect_relevant_dirs "${files[@]}")
if unsafe_config="$(markdownlint_find_unsafe_config "${relevant_dirs[@]}")"; then
  cat > "$output_file" <<EOF
Repository-supplied \`$unsafe_config\` is not supported in this shared linter service because loading JavaScript-based markdownlint configs from untrusted pull requests is unsafe.
Use one of: \`.markdownlint-cli2.jsonc\`, \`.markdownlint-cli2.yaml\`, \`.markdownlint.jsonc\`, \`.markdownlint.json\`, \`.markdownlint.yaml\`, or \`.markdownlint.yml\`.
EOF
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

mapfile -t safe_configs < <(markdownlint_collect_safe_configs "${relevant_dirs[@]}")
if [ "${#safe_configs[@]}" -gt 0 ]; then
  linter_lib::copy_paths_to_root "$temp_repo" "${safe_configs[@]}"
fi

literal_paths=()
for path in "${files[@]}"; do
  literal_paths+=(":$path")
done

run_markdownlint() {
  cd "$temp_repo" || exit 1
  markdownlint-cli2 \
    --no-globs \
    "${literal_paths[@]}"
}

linter_lib::run_and_emit_json "$output_file" run_markdownlint
