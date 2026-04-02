#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

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

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
(?:^|/)(?:Cargo\.(?:toml|lock)|deny\.toml|\.cargo/(?:config(?:\.toml)?))$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_deny_prepare_env

    if command -v cargo >/dev/null 2>&1 && cargo --version >/dev/null 2>&1 && \
       command -v cargo-deny >/dev/null 2>&1 && cargo-deny --version >/dev/null 2>&1; then
      exit 0
    fi

    if ! command -v cargo >/dev/null 2>&1 || ! cargo --version >/dev/null 2>&1; then
      rustup_init="$RUNNER_TEMP/rustup-init"

      rm -rf "$CARGO_HOME" "$RUSTUP_HOME"
      mkdir -p "$CARGO_HOME" "$RUSTUP_HOME"

      curl -fsSL \
        https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
        -o "$rustup_init"
      chmod +x "$rustup_init"

      "$rustup_init" \
        -y \
        --profile minimal \
        --default-toolchain stable \
        --no-modify-path \
        >/dev/null
    fi

    release_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/EmbarkStudios/cargo-deny/releases/latest)"
    version="$(basename "$release_url")"
    asset="cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz"
    archive_path="$RUNNER_TEMP/$asset"
    extract_dir="$RUNNER_TEMP/cargo-deny-extract"
    release_dir="$extract_dir/cargo-deny-${version}-x86_64-unknown-linux-musl"

    rm -rf "$extract_dir"
    mkdir -p "$extract_dir" "$CARGO_HOME/bin"

    curl -fsSL "https://github.com/EmbarkStudios/cargo-deny/releases/download/$version/$asset" -o "$archive_path"
    tar -xzf "$archive_path" -C "$extract_dir"
    cp "$release_dir/cargo-deny" "$CARGO_HOME/bin/cargo-deny"
    chmod +x "$CARGO_HOME/bin/cargo-deny"

    cargo_deny_persist_env
    linter_lib::add_path "$CARGO_HOME/bin"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_deny_prepare_env
    output_file="$RUNNER_TEMP/linter-output.txt"
    result_json_file="$RUNNER_TEMP/cargo-deny-result.json"
    manifest_list_file="$RUNNER_TEMP/cargo-deny-manifests.txt"
    run_target_list_file="$RUNNER_TEMP/cargo-deny-run-targets.tsv"
    run_entries_dir="$RUNNER_TEMP/cargo-deny-runs"
    manifests=()
    normalized_manifests=()
    declare -A seen_normalized_manifests=()
    relevant_dirs=()
    run_targets=()
    unsupported_config=""
    if ! cargo_deny_collect_manifests "$output_file" "$@" > "$manifest_list_file"; then
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi
    mapfile -t manifests < "$manifest_list_file"
    rm -f "$manifest_list_file"

    workspace_root="$RUNNER_TEMP/cargo-deny-workspace"
    source_root="$workspace_root/source"

    rm -rf "$workspace_root"
    mkdir -p "$workspace_root"
    linter_lib::copy_worktree_without_git "$source_root"

    cleanup_workspace() {
      rm -rf "$workspace_root"
    }

    trap cleanup_workspace EXIT

    cargo_deny_collect_run_targets "$source_root" "${manifests[@]}" > "$run_target_list_file"
    mapfile -t run_targets < "$run_target_list_file"
    rm -f "$run_target_list_file"

    for run_target in "${run_targets[@]}"; do
      IFS=$'\t' read -r current_manifest _ <<< "$run_target"
      if [ -z "${seen_normalized_manifests[$current_manifest]+x}" ]; then
        seen_normalized_manifests["$current_manifest"]=1
        normalized_manifests+=("$current_manifest")
      fi
    done

    mapfile -t relevant_dirs < <(linter_lib::collect_cargo_relevant_dirs "${normalized_manifests[@]}")
    if unsupported_config="$(linter_lib::find_unsupported_cargo_config "${relevant_dirs[@]}")"; then
      cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo metadata\` / \`cargo deny check\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-deny\` path.
EOF
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    run_cargo_deny() {
      local failure=0
      local current_manifest config_path command_line run_dir run_exit run_target
      local run_index=0

      cd "$source_root"
      export HOME="$CARGO_HOME"
      rm -rf "$run_entries_dir"
      mkdir -p "$run_entries_dir"

      for run_target in "${run_targets[@]}"; do
        run_index=$((run_index + 1))
        run_dir=$(printf '%s/%04d' "$run_entries_dir" "$run_index")
        mkdir -p "$run_dir"
        IFS=$'\t' read -r current_manifest config_path <<< "$run_target"

        if [ -n "$config_path" ]; then
          command_line="cargo-deny --format json --color never --log-level warn --all-features --manifest-path $current_manifest check --audit-compatible-output --config $config_path"
          set +e
          cargo-deny \
            --format json \
            --color never \
            --log-level warn \
            --all-features \
            --manifest-path "$current_manifest" \
            check \
            --audit-compatible-output \
            --config "$config_path" >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
          run_exit=$?
          set -e
        else
          command_line="cargo-deny --format json --color never --log-level warn --all-features --manifest-path $current_manifest check --audit-compatible-output"
          set +e
          cargo-deny \
            --format json \
            --color never \
            --log-level warn \
            --all-features \
            --manifest-path "$current_manifest" \
            check \
            --audit-compatible-output >"$run_dir/stdout.txt" 2>"$run_dir/stderr.txt"
          run_exit=$?
          set -e
        fi

        printf '%s\n' "$command_line" > "$run_dir/command.txt"
        printf '%s\n' "$current_manifest" > "$run_dir/manifest_path.txt"
        printf '%s\n' "$config_path" > "$run_dir/config_path.txt"
        printf '%s\n' "$run_exit" > "$run_dir/exit_code.txt"

        if [ "$run_exit" -ne 0 ]; then
          failure=1
        fi
      done

      return "$failure"
    }

    if run_cargo_deny; then
      exit_code=0
    else
      exit_code=1
    fi

    node "$script_dir/../cargo-deny-result.js" "$run_entries_dir" "$exit_code" > "$result_json_file"
    cat "$result_json_file"
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
