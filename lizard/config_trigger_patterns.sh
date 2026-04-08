#!/usr/bin/env bash

set -euo pipefail

cat <<'EOF'
^\.github\/linter-service\.(?:json|ya?ml)$
^whitelizard\.txt$
EOF
