#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
native_sarif_file="$RUNNER_TEMP/zizmor-native.sarif"
stderr_file="$RUNNER_TEMP/zizmor-stderr.log"
rm -f "$native_sarif_file" "$stderr_file"

# .github/workflows/actions.lock is a config trigger, not a direct audit
# target. zizmor discovers it from the repository layout, so exclude it from
# the explicit input list to avoid passing a non-workflow file as an input.
filtered_args=()
for arg in "$@"; do
  case "$arg" in
    .github/workflows/actions.lock|./.github/workflows/actions.lock)
      continue
      ;;
    *)
      filtered_args+=("$arg")
      ;;
  esac
done

if [ "${#filtered_args[@]}" -eq 0 ]; then
  cat >"$native_sarif_file" <<'EOF'
{"$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"zizmor"}},"results":[]}]}
EOF
  : >"$stderr_file"
  linter_lib::emit_json_result_with_sarif_findings "$native_sarif_file"
  exit 0
fi

set +e
zizmor --offline --color=never --format=sarif "${filtered_args[@]}" >"$native_sarif_file" 2>"$stderr_file"
set -e

if [ ! -s "$native_sarif_file" ]; then
  echo "zizmor native SARIF output was empty or missing" >&2
  if [ -s "$stderr_file" ]; then
    cat "$stderr_file" >&2
  fi
  exit 1
fi

if [ -s "$stderr_file" ]; then
  cat "$stderr_file" >&2
fi
rm -f "$stderr_file"

linter_lib::emit_json_result_with_sarif_findings "$native_sarif_file"
