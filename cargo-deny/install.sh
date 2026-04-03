#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
cargo_deny_prepare_env

if command -v cargo >/dev/null 2>&1 && cargo --version >/dev/null 2>&1 && \
   command -v cargo-deny >/dev/null 2>&1 && cargo-deny --version >/dev/null 2>&1; then
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1 || ! cargo --version >/dev/null 2>&1; then
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
    --no-modify-path \
    >/dev/null
fi

release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/EmbarkStudios/cargo-deny/releases/latest)"
version="$(basename "$release_url")"
asset="cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz"
archive_path="$RUNNER_TEMP/$asset"
extract_dir="$RUNNER_TEMP/cargo-deny-extract"
release_dir="$extract_dir/cargo-deny-${version}-x86_64-unknown-linux-musl"

rm -rf "$extract_dir"
mkdir -p "$extract_dir" "$CARGO_HOME/bin"

curl -fsSL "https://github.com/EmbarkStudios/cargo-deny/releases/download/$version/$asset" -o "$archive_path"
tar -xzf "$archive_path" -C "$extract_dir"
cp "$release_dir/cargo-deny" "$CARGO_HOME/bin/cargo-deny"
chmod +x "$CARGO_HOME/bin/cargo-deny"

cargo_deny_persist_env
linter_lib::add_path "$CARGO_HOME/bin"
