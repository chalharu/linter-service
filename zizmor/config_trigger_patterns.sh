#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
^(?:zizmor\.(?:yaml|yml)|\.github\/zizmor\.(?:yaml|yml))$
EOF
