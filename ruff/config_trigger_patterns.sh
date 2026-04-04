#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
(?:^|\/)(?:pyproject\.toml|ruff\.toml|\.ruff\.toml)$
EOF
