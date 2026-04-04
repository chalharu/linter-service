#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
^(?:\.trivyignore|trivy\.(?:yaml|yml))$
EOF
