#!/usr/bin/env bash

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

: "${CHECKER_PRIVATE_KEY:?CHECKER_PRIVATE_KEY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"

node -e 'const crypto = require("node:crypto"); process.stdout.write(crypto.createHmac("sha256", process.env.CHECKER_PRIVATE_KEY).update(process.env.GITHUB_RUN_ID).digest("hex"));'
