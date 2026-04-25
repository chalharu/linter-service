#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
native_sarif_file="$RUNNER_TEMP/zizmor-native.sarif"
stderr_file="$RUNNER_TEMP/zizmor-stderr.log"
rm -f "$native_sarif_file" "$stderr_file"

set +e
zizmor --offline --color=never --format=sarif "$@" >"$native_sarif_file" 2>"$stderr_file"
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

# In SARIF mode, findings are communicated in the SARIF payload rather than
# through zizmor's findings-specific exit codes, so normalize to 0/1 here.
exit_code=0
if python_bin="$(linter_lib::python_cmd 2>/dev/null)"; then
  exit_code=$("$python_bin" - "$native_sarif_file" <<'PY'
import json, sys
sarif = json.loads(open(sys.argv[1]).read())
has_results = any(len(run.get("results", [])) > 0 for run in sarif.get("runs", []))
print("1" if has_results else "0")
PY
  )
elif command -v node >/dev/null 2>&1; then
  exit_code=$(node - "$native_sarif_file" <<'NODE'
const fs = require("node:fs");
const sarif = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hasResults = (sarif?.runs ?? []).some((r) => (r?.results?.length ?? 0) > 0);
process.stdout.write(hasResults ? "1" : "0");
NODE
  )
else
  echo "python3, python, or node is required" >&2
  exit 1
fi

linter_lib::emit_json_result_with_sarif "$exit_code" "$native_sarif_file"
