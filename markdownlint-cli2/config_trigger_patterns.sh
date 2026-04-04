#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
(?:^|\/)\.(?:markdownlint-cli2\.(?:jsonc|yaml|cjs|mjs)|markdownlint\.(?:jsonc|json|yaml|yml|cjs|mjs))$
EOF
