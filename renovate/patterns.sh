#!/usr/bin/env bash

set -euo pipefail

cat <<'EOF'
^(?:renovate\.json5?|\.github\/renovate\.json5?|\.gitlab\/renovate\.json5?|\.renovaterc(?:\.json5?)?)$
EOF
