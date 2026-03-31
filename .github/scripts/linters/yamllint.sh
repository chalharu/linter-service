#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/../linter-library.sh"

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:yaml|yml)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    linter_lib::install_python_tools "$RUNNER_TEMP/yamllint-venv" yamllint
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    output_file="$RUNNER_TEMP/linter-output.txt"
    yamllint_config=""
    for candidate in .yamllint .yamllint.yaml .yamllint.yml; do
      if [ -f "$candidate" ]; then
        yamllint_config="$candidate"
        break
      fi
    done

    if [ -z "$yamllint_config" ]; then
      yamllint_config="$RUNNER_TEMP/yamllint.yaml"
      cat > "$yamllint_config" <<'EOF'
extends: default
rules:
  comments-indentation: disable
  document-start: disable
  line-length: disable
  truthy:
    check-keys: false
EOF
    fi

    set +e
    yamllint -c "$yamllint_config" "$@" >"$output_file" 2>&1
    exit_code=$?
    set -e
    linter_lib::emit_json_result "$exit_code" "$output_file"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
