#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../linter-library.sh"

resolve_spectral_ruleset() {
  local default_ruleset=$1
  local config_path

  for config_path in \
    .spectral.yml \
    .spectral.yaml \
    .spectral.json
  do
    if [ -f "$config_path" ]; then
      printf '%s\n' "$config_path"
      return 0
    fi
  done

  if [ -f .spectral.js ]; then
    return 1
  fi

  printf '%s\n' \
    'extends:' \
    '  - spectral:oas' > "$default_ruleset"
  printf '%s\n' "$default_ruleset"
}

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:json|yaml|yml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    linter_lib::install_node_tools "$RUNNER_TEMP/spectral/npm-global" @stoplight/spectral-cli
    ;;
  run)
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
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
