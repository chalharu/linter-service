#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

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
    yamlfmt_config=""

    if ! yamlfmt_config="$(yamlfmt_find_config)"; then
      yamlfmt_config="$RUNNER_TEMP/yamlfmt.yaml"
      cat > "$yamlfmt_config" <<'EOF'
formatter:
  type: basic
EOF
    fi

    linter_lib::run_and_emit_json \
      "$output_file" \
      yamlfmt \
      -lint \
      -conf "$yamlfmt_config" \
      "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
