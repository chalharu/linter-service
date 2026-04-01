#!/usr/bin/env bash

set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

if [ "$#" -ne 3 ]; then
  echo "usage: $0 {encrypt|decrypt} <input> <output>" >&2
  exit 1
fi

mode=$1
input_path=$2
output_path=$3

: "${ARTIFACT_PASSPHRASE:?ARTIFACT_PASSPHRASE is required}"

mkdir -p "$(dirname "$output_path")"

case "$mode" in
  encrypt)
    openssl enc -aes-256-cbc -pbkdf2 -md sha256 -salt \
      -in "$input_path" \
      -out "$output_path" \
      -pass env:ARTIFACT_PASSPHRASE
    ;;
  decrypt)
    openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 \
      -in "$input_path" \
      -out "$output_path" \
      -pass env:ARTIFACT_PASSPHRASE
    ;;
  *)
    echo "usage: $0 {encrypt|decrypt} <input> <output>" >&2
    exit 1
    ;;
esac
