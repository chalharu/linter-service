#!/usr/bin/env bash

set -euo pipefail

cat <<'EOF'
(?:^|/)Chart\.yaml$
(?:^|/)Chart\.lock$
(?:^|/)values(?:[._-][^/]+)?\.ya?ml$
(?:^|/)values\.schema\.json$
(?:^|/)(?:templates|crds)/.+$
(?:^|/)charts/.+$
EOF
