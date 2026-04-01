#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

cargo_fmt_prepare_env() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

  export CARGO_HOME="${CARGO_HOME:-$RUNNER_TEMP/cargo}"
  export RUSTUP_HOME="${RUSTUP_HOME:-$RUNNER_TEMP/rustup}"
  export PATH="$CARGO_HOME/bin:$PATH"
}

cargo_fmt_persist_env() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'CARGO_HOME=%s\n' "$CARGO_HOME" >> "$GITHUB_ENV"
    printf 'RUSTUP_HOME=%s\n' "$RUSTUP_HOME" >> "$GITHUB_ENV"
  fi
}

cargo_fmt_find_manifest() {
  local path=$1
  local current_dir candidate

  current_dir=$(dirname "$path")
  while :; do
    candidate="$current_dir/Cargo.toml"
    if [ -f "$candidate" ]; then
      printf '%s\n' "${candidate#./}"
      return 0
    fi

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
\.(?:rs)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_fmt_prepare_env

    if command -v cargo >/dev/null 2>&1 && cargo fmt --version >/dev/null 2>&1; then
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

    cargo_fmt_persist_env
    linter_lib::add_path "$CARGO_HOME/bin"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_fmt_prepare_env
    output_file="$RUNNER_TEMP/linter-output.txt"
    manifests=()
    missing_files=()
    declare -A seen_manifests=()
    path=""
    manifest_path=""

    for path in "$@"; do
      if ! manifest_path=$(cargo_fmt_find_manifest "$path"); then
        missing_files+=("$path")
        continue
      fi

      if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
        seen_manifests["$manifest_path"]=1
        manifests+=("$manifest_path")
      fi
    done

    if [ "${#missing_files[@]}" -gt 0 ]; then
      {
        echo "Cargo fmt requires each selected Rust file to belong to a Cargo package."
        echo "No Cargo.toml found for:"
        for path in "${missing_files[@]}"; do
          printf ' - %s\n' "$path"
        done
      } > "$output_file"
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    run_cargo_fmt() {
      local failure=0
      local current_manifest

      for current_manifest in "${manifests[@]}"; do
        printf '==> cargo fmt --check --manifest-path %s\n' "$current_manifest"
        if ! cargo fmt --check --manifest-path "$current_manifest"; then
          failure=1
        fi
        echo
      done

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_cargo_fmt
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
