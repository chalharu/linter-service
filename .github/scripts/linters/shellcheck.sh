#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:bash|ksh|sh)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/koalaman/shellcheck/releases/latest)"
    version="$(basename "$release_url")"
    asset="shellcheck-${version}.linux.x86_64.tar.gz"
    archive_path="$RUNNER_TEMP/$asset"
    extract_dir="$RUNNER_TEMP/shellcheck-extract"
    bin_dir="$RUNNER_TEMP/shellcheck/bin"

    rm -rf "$extract_dir" "$bin_dir"
    mkdir -p "$extract_dir" "$bin_dir"

    curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/$version/$asset" -o "$archive_path"
    tar -xzf "$archive_path" -C "$extract_dir"
    cp "$extract_dir/shellcheck-$version/shellcheck" "$bin_dir/shellcheck"
    chmod +x "$bin_dir/shellcheck"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    linter_lib::run_and_emit_json "$output_file" shellcheck -x -P SCRIPTDIR "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
