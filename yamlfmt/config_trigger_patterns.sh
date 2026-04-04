#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
^(?:\.yamlfmt|yamlfmt\.(?:yaml|yml)|\.yamlfmt\.(?:yaml|yml))$
EOF
