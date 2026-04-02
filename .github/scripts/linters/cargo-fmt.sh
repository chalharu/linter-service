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

cargo_fmt_resolve_workspace_manifest() {
  local source_root=$1
  local manifest_path=$2

  (
    cd "$source_root" &&
      linter_lib::resolve_cargo_workspace_manifest "$source_root" "$manifest_path" cargo
  )
}

cargo_fmt_normalize_manifests() {
  local source_root=$1
  shift

  local -A seen_manifests=()
  local manifest_path normalized_manifest

  for manifest_path in "$@"; do
    normalized_manifest=$(cargo_fmt_resolve_workspace_manifest "$source_root" "$manifest_path")
    if [ -n "${seen_manifests[$normalized_manifest]+x}" ]; then
      continue
    fi

    seen_manifests["$normalized_manifest"]=1
    printf '%s\n' "$normalized_manifest"
  done
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
    repo_root=$(pwd -P)
    manifests=()
    if ! linter_lib::collect_cargo_manifests "$output_file" "Cargo fmt" manifests "$@"; then
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi
    mapfile -t manifests < <(cargo_fmt_normalize_manifests "$repo_root" "${manifests[@]}")

    run_cargo_fmt() {
      local failure=0
      local current_manifest
      local display_command
      local -a cargo_fmt_args

      for current_manifest in "${manifests[@]}"; do
        cargo_fmt_args=(fmt --check --manifest-path "$current_manifest")
        display_command="cargo fmt --check --manifest-path $current_manifest"

        if linter_lib::cargo_manifest_is_virtual_workspace "$current_manifest"; then
          cargo_fmt_args=(fmt --check --all --manifest-path "$current_manifest")
          display_command="cargo fmt --check --all --manifest-path $current_manifest"
        fi

        printf '==> %s\n' "$display_command"
        if ! cargo "${cargo_fmt_args[@]}"; then
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
