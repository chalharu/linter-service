#!/usr/bin/env bash

set -euo pipefail

cat <<'EOF'
(?:^|/)\.github/linter-service\.(?:json|ya?ml)$
(?:^|/)(?:rust-toolchain(?:\.toml)?|\.cargo/config(?:\.toml)?)$
EOF
