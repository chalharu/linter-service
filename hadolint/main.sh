#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

hadolint_find_config() {
  local path=$1
  local current_dir candidate

  current_dir=$(dirname "$path")
  while :; do
    for candidate in "$current_dir/.hadolint.yaml" "$current_dir/.hadolint.yml"; do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
        return 0
      fi
    done

    if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
      break
    fi

    current_dir=$(dirname "$current_dir")
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
(?:^|/)(?:Dockerfile(?:\.[^/]+)?|Containerfile(?:\.[^/]+)?|[^/]+\.(?:dockerfile|containerfile))$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

    if command -v hadolint >/dev/null 2>&1 && hadolint --version >/dev/null 2>&1; then
      exit 0
    fi

    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/hadolint/hadolint/releases/latest)"
    version="$(basename "$release_url")"
    asset="hadolint-linux-x86_64"
    bin_dir="$RUNNER_TEMP/hadolint/bin"

    rm -rf "$bin_dir"
    mkdir -p "$bin_dir"

    curl -fsSL "https://github.com/hadolint/hadolint/releases/download/$version/$asset" -o "$bin_dir/hadolint"
    chmod +x "$bin_dir/hadolint"
    linter_lib::add_path "$bin_dir"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"

    run_hadolint() {
      local failure=0
      local path config_path

      for path in "$@"; do
        if config_path=$(hadolint_find_config "$path"); then
          printf '==> hadolint --no-color --config %s %s\n' "$config_path" "$path"
          if ! hadolint --no-color --config "$config_path" "$path"; then
            failure=1
          fi
        else
          printf '==> hadolint --no-color %s\n' "$path"
          if ! hadolint --no-color "$path"; then
            failure=1
          fi
        fi
        echo
      done

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_hadolint "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
