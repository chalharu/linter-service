#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
(?:^|\/)\.editorconfig$
^(?:\.editorconfig-checker\.json|\.ecrc)$
EOF
