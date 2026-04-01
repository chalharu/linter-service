#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
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
    files=("$@")
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

    run_yamllint() {
      yamllint -c "$yamllint_config" "${files[@]}"
    }

    linter_lib::run_and_emit_json "$output_file" run_yamllint
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
