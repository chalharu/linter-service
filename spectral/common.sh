#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

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
