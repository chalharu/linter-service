#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
(?:^|\/)(?:clippy\.toml|\.clippy\.toml|rust-toolchain(?:\.toml)?|\.cargo\/config(?:\.toml)?)$
EOF
