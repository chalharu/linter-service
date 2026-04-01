#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$script_dir/../linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
^\.github\/workflows\/.+\.(?:yaml|yml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/suzuki-shunsuke/ghalint/releases/latest)"
    version="$(basename "$release_url")"
    version_number="${version#v}"
    asset="ghalint_${version_number}_linux_amd64.tar.gz"
    bin_dir="$RUNNER_TEMP/ghalint/bin"
    mkdir -p "$bin_dir"
    curl -fsSL "https://github.com/suzuki-shunsuke/ghalint/releases/download/$version/$asset" -o "$RUNNER_TEMP/$asset"
    tar -xzf "$RUNNER_TEMP/$asset" -C "$bin_dir"
    chmod +x "$bin_dir/ghalint"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    temp_repo="$RUNNER_TEMP/ghalint-repo"
    rm -rf "$temp_repo"
    mkdir -p "$temp_repo"
    linter_lib::copy_paths_to_root "$temp_repo" "$@"
    linter_lib::copy_first_existing_path "$temp_repo" \
      .ghalint.yaml \
      .ghalint.yml \
      ghalint.yaml \
      ghalint.yml \
      .github/ghalint.yaml \
      .github/ghalint.yml || true

    run_ghalint() {
      cd "$temp_repo" || exit 1
      GHALINT_LOG_COLOR=never ghalint run
    }

    linter_lib::run_and_emit_json "$output_file" run_ghalint
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
