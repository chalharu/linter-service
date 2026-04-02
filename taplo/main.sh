#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:toml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/tamasfe/taplo/releases/latest)"
    version="$(basename "$release_url")"
    asset="taplo-linux-x86_64.gz"
    bin_dir="$RUNNER_TEMP/taplo/bin"
    download_path="$bin_dir/taplo.gz"

    rm -rf "$bin_dir"
    mkdir -p "$bin_dir"

    curl -fsSL "https://github.com/tamasfe/taplo/releases/download/$version/$asset" -o "$download_path"
    gzip -d "$download_path"
    chmod +x "$bin_dir/taplo"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    linter_lib::run_and_emit_json \
      "$output_file" \
      taplo fmt \
      --check \
      --diff \
      --colors never \
      "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
