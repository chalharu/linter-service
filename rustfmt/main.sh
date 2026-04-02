#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

rustfmt_prepare_env() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

  export CARGO_HOME="${CARGO_HOME:-$RUNNER_TEMP/cargo}"
  export RUSTUP_HOME="${RUSTUP_HOME:-$RUNNER_TEMP/rustup}"
  export PATH="$CARGO_HOME/bin:$PATH"
}

rustfmt_persist_env() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'CARGO_HOME=%s\n' "$CARGO_HOME" >> "$GITHUB_ENV"
    printf 'RUSTUP_HOME=%s\n' "$RUSTUP_HOME" >> "$GITHUB_ENV"
  fi
}

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:rs)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    rustfmt_prepare_env

    if command -v rustfmt >/dev/null 2>&1 && rustfmt --version >/dev/null 2>&1; then
      exit 0
    fi

    rustup_init="$RUNNER_TEMP/rustup-init"

    rm -rf "$CARGO_HOME" "$RUSTUP_HOME"
    mkdir -p "$CARGO_HOME" "$RUSTUP_HOME"

    curl -fsSL \
      https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
      -o "$rustup_init"
    chmod +x "$rustup_init"

    "$rustup_init" \
      -y \
      --profile minimal \
      --default-toolchain stable \
      --component rustfmt \
      --no-modify-path \
      >/dev/null

    rustfmt_persist_env
    linter_lib::add_path "$CARGO_HOME/bin"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    rustfmt_prepare_env
    output_file="$RUNNER_TEMP/linter-output.txt"

    run_rustfmt() {
      local failure=0
      local current_file
      local -a unique_files=()
      local -A seen_files=()

      for current_file in "$@"; do
        if [ -n "${seen_files[$current_file]+x}" ]; then
          continue
        fi

        seen_files["$current_file"]=1
        unique_files+=("$current_file")
      done

      for current_file in "${unique_files[@]}"; do
        printf '==> rustfmt --check %s\n' "$current_file"
        if ! rustfmt --check "$current_file"; then
          failure=1
        fi
        echo
      done

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_rustfmt "$@"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
