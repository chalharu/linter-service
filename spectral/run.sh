#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"
files=("$@")
if ! spectral_ruleset="$(resolve_spectral_ruleset "$RUNNER_TEMP/default-spectral-ruleset.yaml")"; then
  cat > "$output_file" <<'EOF'
Repository-supplied `.spectral.js` is not supported in this shared linter service because loading JavaScript rulesets from untrusted pull requests is unsafe.
Use one of: `.spectral.yml`, `.spectral.yaml`, or `.spectral.json`.
EOF
  linter_lib::emit_json_result 1 "$output_file"
  exit 0
fi

run_spectral() {
  spectral lint \
    --format text \
    --ignore-unknown-format \
    --quiet \
    --ruleset "$spectral_ruleset" \
    "${files[@]}"
}

linter_lib::run_and_emit_json "$output_file" run_spectral
