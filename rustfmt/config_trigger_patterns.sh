#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
(?:^|\/)(?:rustfmt\.toml|\.rustfmt\.toml|rust-toolchain(?:\.toml)?)$
EOF
