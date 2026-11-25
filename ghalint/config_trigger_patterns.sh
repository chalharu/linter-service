#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
^(?:\.ghalint\.(?:yaml|yml)|ghalint\.(?:yaml|yml)|\.github\/ghalint\.(?:yaml|yml))$
^\.github\/workflows\/actions\.lock$
EOF
