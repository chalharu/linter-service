#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

markdownlint_collect_relevant_dirs() {
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

markdownlint_find_unsafe_config() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.markdownlint-cli2.cjs" \
      "$dir/.markdownlint-cli2.mjs" \
      "$dir/.markdownlint.cjs" \
      "$dir/.markdownlint.mjs"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
        return 0
      fi
    done
  done

  return 1
}

markdownlint_collect_safe_configs() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.markdownlint-cli2.jsonc" \
      "$dir/.markdownlint-cli2.yaml" \
      "$dir/.markdownlint.jsonc" \
      "$dir/.markdownlint.json" \
      "$dir/.markdownlint.yaml" \
      "$dir/.markdownlint.yml"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
      fi
    done
  done
}

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:md|markdown)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    linter_lib::install_node_tools "$RUNNER_TEMP/markdownlint-cli2/npm-global" markdownlint-cli2
    ;;
  run)
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
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
