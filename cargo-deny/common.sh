#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"

cargo_deny_prepare_env() {
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"

  export CARGO_HOME="${CARGO_HOME:-$RUNNER_TEMP/cargo}"
  export RUSTUP_HOME="${RUSTUP_HOME:-$RUNNER_TEMP/rustup}"
  export PATH="$CARGO_HOME/bin:$PATH"
  export CARGO_TERM_COLOR=never
}

cargo_deny_persist_env() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'CARGO_HOME=%s\n' "$CARGO_HOME" >> "$GITHUB_ENV"
    printf 'RUSTUP_HOME=%s\n' "$RUSTUP_HOME" >> "$GITHUB_ENV"
  fi
}

cargo_deny_find_config() {
  local manifest_path=$1
  local current_dir candidate

  current_dir=$(dirname "$manifest_path")
  while :; do
    candidate="$current_dir/deny.toml"
    if [ -f "$candidate" ]; then
      printf '%s\n' "${candidate#./}"
      return 0
    fi

    if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
      break
    fi

    current_dir=$(dirname "$current_dir")
  done

  return 1
}

cargo_deny_list_manifests() {
  find . -type f -name Cargo.toml -print | LC_ALL=C sort | sed 's#^\./##'
}

cargo_deny_manifest_in_config_scope() {
  local manifest_path=$1
  local config_path=$2
  local manifest_dir scope_dir

  manifest_dir=$(dirname "$manifest_path")
  scope_dir=$(dirname "$(dirname "$config_path")")

  if [ "$scope_dir" = "." ]; then
    return 0
  fi

  case "$manifest_dir" in
    "$scope_dir" | "$scope_dir"/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

cargo_deny_collect_manifests() {
  local output_file=$1
  shift

  local -A seen_manifests=()
  local -a all_manifests=()
  local manifests=()
  local missing_files=()
  local selected_path manifest_path config_path matched

  mapfile -t all_manifests < <(cargo_deny_list_manifests)

  for selected_path in "$@"; do
    selected_path="${selected_path#./}"
    matched=0

    case "$selected_path" in
      Cargo.toml | */Cargo.toml | Cargo.lock | */Cargo.lock)
        if manifest_path=$(linter_lib::find_cargo_manifest "$selected_path"); then
          if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
            seen_manifests["$manifest_path"]=1
            manifests+=("$manifest_path")
          fi
          matched=1
        fi
        ;;
      deny.toml | */deny.toml)
        for manifest_path in "${all_manifests[@]}"; do
          if config_path=$(cargo_deny_find_config "$manifest_path") && [ "$config_path" = "$selected_path" ]; then
            if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
              seen_manifests["$manifest_path"]=1
              manifests+=("$manifest_path")
            fi
            matched=1
          fi
        done
        ;;
      .cargo/config | */.cargo/config | .cargo/config.toml | */.cargo/config.toml)
        for manifest_path in "${all_manifests[@]}"; do
          if cargo_deny_manifest_in_config_scope "$manifest_path" "$selected_path"; then
            if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
              seen_manifests["$manifest_path"]=1
              manifests+=("$manifest_path")
            fi
            matched=1
          fi
        done
        ;;
      *)
        if manifest_path=$(linter_lib::find_cargo_manifest "$selected_path"); then
          if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
            seen_manifests["$manifest_path"]=1
            manifests+=("$manifest_path")
          fi
          matched=1
        fi
        ;;
    esac

    if [ "$matched" -eq 0 ]; then
      missing_files+=("$selected_path")
    fi
  done

  if [ "${#missing_files[@]}" -gt 0 ]; then
    {
      echo "Cargo deny requires each selected file to belong to a Cargo package."
      echo "No Cargo.toml found for:"
      for selected_path in "${missing_files[@]}"; do
        printf ' - %s\n' "$selected_path"
      done
    } > "$output_file"
    return 1
  fi

  printf '%s\n' "${manifests[@]}"
  return 0
}

cargo_deny_resolve_workspace_manifest() {
  local source_root=$1
  local manifest_path=$2

  (
    cd "$source_root" &&
      linter_lib::resolve_cargo_workspace_manifest "$source_root" "$manifest_path" cargo
  )
}

cargo_deny_collect_run_targets() {
  local source_root=$1
  shift

  local -A seen_targets=()
  local original_manifest workspace_manifest config_path key

  for original_manifest in "$@"; do
    workspace_manifest=$(cargo_deny_resolve_workspace_manifest "$source_root" "$original_manifest")
    config_path=""
    if config_path=$(cargo_deny_find_config "$original_manifest"); then
      :
    else
      config_path=""
    fi

    key="$workspace_manifest"$'\t'"$config_path"
    if [ -n "${seen_targets[$key]+x}" ]; then
      continue
    fi

    seen_targets["$key"]=1
    printf '%s\t%s\n' "$workspace_manifest" "$config_path"
  done
}
