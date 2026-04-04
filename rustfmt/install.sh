#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
rustfmt_prepare_env
# renovate: datasource=rust depName=rust versioning=semver
rust_toolchain_version="1.94.1"

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
  --default-toolchain "$rust_toolchain_version" \
  --component rustfmt \
  --no-modify-path \
  >/dev/null

rustfmt_persist_env
linter_lib::add_path "$CARGO_HOME/bin"
