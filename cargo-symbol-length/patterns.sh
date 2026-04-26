#!/usr/bin/env bash

set -euo pipefail

cat <<'EOF'
\.(?:rs)$
(?:^|\/)Cargo\.(?:toml|lock)$
EOF
