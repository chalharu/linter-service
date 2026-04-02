#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

yamlfmt_find_config() {
  local candidate

  for candidate in .yamlfmt yamlfmt.yml yamlfmt.yaml .yamlfmt.yaml .yamlfmt.yml; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

yamlfmt_first_difference_line() {
  local original_path=$1
  local formatted_path=$2
  local line_number

  line_number=$(
    diff -U0 "$original_path" "$formatted_path" 2>/dev/null |
      sed -n 's/^@@ -\([0-9]\+\)\(,[0-9]\+\)\? +[0-9]\+\(,[0-9]\+\)\? @@.*/\1/p' |
      head -n 1
  )

  if [ -z "$line_number" ] || [ "$line_number" -le 0 ]; then
    printf '1\n'
    return 0
  fi

  printf '%s\n' "$line_number"
}

yamlfmt_collect_line_summaries() {
  local yamlfmt_config=$1
  shift

  local scratch_dir="$RUNNER_TEMP/yamlfmt-line-summaries"
  local selected_path formatted_copy copy_path display_path line_number

  rm -rf "$scratch_dir"
  mkdir -p "$scratch_dir"

  for selected_path in "$@"; do
    if [ ! -f "$selected_path" ]; then
      continue
    fi

    display_path="${selected_path#./}"
    copy_path="$display_path"
    if [ "${selected_path#/}" != "$selected_path" ]; then
      copy_path="absolute/${selected_path#/}"
    fi

    formatted_copy="$scratch_dir/$copy_path"
    mkdir -p "$(dirname "$formatted_copy")"
    cp "$selected_path" "$formatted_copy"

    if ! yamlfmt -conf "$yamlfmt_config" "$formatted_copy" >/dev/null 2>&1; then
      continue
    fi

    if cmp -s "$selected_path" "$formatted_copy"; then
      continue
    fi

    line_number=$(yamlfmt_first_difference_line "$selected_path" "$formatted_copy")
    printf '%s:%s: yamlfmt would reformat this file\n' "$display_path" "$line_number"
  done

  rm -rf "$scratch_dir"
}

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:yaml|yml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

    if command -v yamlfmt >/dev/null 2>&1 && yamlfmt -version >/dev/null 2>&1; then
      exit 0
    fi

    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/google/yamlfmt/releases/latest)"
    version="$(basename "$release_url")"
    asset_version="${version#v}"
    asset="yamlfmt_${asset_version}_Linux_x86_64.tar.gz"
    archive_path="$RUNNER_TEMP/$asset"
    extract_dir="$RUNNER_TEMP/yamlfmt-extract"
    bin_dir="$RUNNER_TEMP/yamlfmt/bin"

    rm -rf "$extract_dir" "$bin_dir"
    mkdir -p "$extract_dir" "$bin_dir"

    curl -fsSL "https://github.com/google/yamlfmt/releases/download/$version/$asset" -o "$archive_path"
    tar -xzf "$archive_path" -C "$extract_dir"
    cp "$extract_dir/yamlfmt" "$bin_dir/yamlfmt"
    chmod +x "$bin_dir/yamlfmt"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    enriched_output_file="$RUNNER_TEMP/yamlfmt-output-enriched.txt"
    summary_file="$RUNNER_TEMP/yamlfmt-line-summary.txt"
    yamlfmt_config=""

    if ! yamlfmt_config="$(yamlfmt_find_config)"; then
      yamlfmt_config="$RUNNER_TEMP/yamlfmt.yaml"
      cat > "$yamlfmt_config" <<'EOF'
formatter:
  type: basic
EOF
    fi

    set +e
    yamlfmt \
      -lint \
      -conf "$yamlfmt_config" \
      "$@" >"$output_file" 2>&1
    exit_code=$?
    set -e

    if [ "$exit_code" -ne 0 ]; then
      yamlfmt_collect_line_summaries "$yamlfmt_config" "$@" > "$summary_file"
      if [ -s "$summary_file" ]; then
        cat "$summary_file" > "$enriched_output_file"
        if [ -s "$output_file" ]; then
          printf '\n' >> "$enriched_output_file"
          cat "$output_file" >> "$enriched_output_file"
        fi
        mv "$enriched_output_file" "$output_file"
      fi
      rm -f "$summary_file" "$enriched_output_file"
    fi

    linter_lib::emit_json_result "$exit_code" "$output_file"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
