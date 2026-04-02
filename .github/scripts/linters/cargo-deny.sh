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

cargo_deny_append_manifest() {
  local manifest_path=$1
  local seen_var=$2
  local manifests_var=$3
  local -n seen_ref="$seen_var"
  local -n manifests_ref="$manifests_var"

  if [ -z "${seen_ref[$manifest_path]+x}" ]; then
    seen_ref["$manifest_path"]=1
    manifests_ref+=("$manifest_path")
  fi
}

cargo_deny_collect_manifests() {
  local output_file=$1
  local manifests_var=$2
  shift 2

  local -n collected_manifests_ref="$manifests_var"
  local -A seen_manifests=()
  local -a all_manifests=()
  local missing_files=()
  local selected_path manifest_path config_path matched

  collected_manifests_ref=()
  mapfile -t all_manifests < <(cargo_deny_list_manifests)

  for selected_path in "$@"; do
    selected_path="${selected_path#./}"
    matched=0

    case "$selected_path" in
      Cargo.toml | */Cargo.toml | Cargo.lock | */Cargo.lock)
        if manifest_path=$(linter_lib::find_cargo_manifest "$selected_path"); then
          cargo_deny_append_manifest "$manifest_path" seen_manifests collected_manifests_ref
          matched=1
        fi
        ;;
      deny.toml | */deny.toml)
        for manifest_path in "${all_manifests[@]}"; do
          if config_path=$(cargo_deny_find_config "$manifest_path") && [ "$config_path" = "$selected_path" ]; then
            cargo_deny_append_manifest "$manifest_path" seen_manifests collected_manifests_ref
            matched=1
          fi
        done
        ;;
      .cargo/config | */.cargo/config | .cargo/config.toml | */.cargo/config.toml)
        for manifest_path in "${all_manifests[@]}"; do
          if cargo_deny_manifest_in_config_scope "$manifest_path" "$selected_path"; then
            cargo_deny_append_manifest "$manifest_path" seen_manifests collected_manifests_ref
            matched=1
          fi
        done
        ;;
      *)
        if manifest_path=$(linter_lib::find_cargo_manifest "$selected_path"); then
          cargo_deny_append_manifest "$manifest_path" seen_manifests collected_manifests_ref
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

  return 0
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
    manifests=()
    relevant_dirs=()
    unsupported_config=""
    if ! cargo_deny_collect_manifests "$output_file" manifests "$@"; then
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    mapfile -t relevant_dirs < <(linter_lib::collect_cargo_relevant_dirs "${manifests[@]}")
    if unsupported_config="$(linter_lib::find_unsupported_cargo_config "${relevant_dirs[@]}")"; then
      cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo metadata\` / \`cargo deny check\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-deny\` path.
EOF
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    workspace_root="$RUNNER_TEMP/cargo-deny-workspace"
    source_root="$workspace_root/source"

    rm -rf "$workspace_root"
    mkdir -p "$workspace_root"
    linter_lib::copy_worktree_without_git "$source_root"

    cleanup_workspace() {
      rm -rf "$workspace_root"
    }

    trap cleanup_workspace EXIT

    run_cargo_deny() {
      local failure=0
      local current_manifest config_path

      cd "$source_root"
      export HOME="$CARGO_HOME"

      for current_manifest in "${manifests[@]}"; do
        if config_path=$(cargo_deny_find_config "$current_manifest"); then
          printf '==> cargo-deny --color never --log-level warn --all-features --manifest-path %s check --config %s\n' "$current_manifest" "$config_path"
          if ! cargo-deny \
            --color never \
            --log-level warn \
            --all-features \
            --manifest-path "$current_manifest" \
            check \
            --config "$config_path"; then
            failure=1
          fi
        else
          printf '==> cargo-deny --color never --log-level warn --all-features --manifest-path %s check\n' "$current_manifest"
          if ! cargo-deny \
            --color never \
            --log-level warn \
            --all-features \
            --manifest-path "$current_manifest" \
            check; then
            failure=1
          fi
        fi
        echo
      done

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_cargo_deny
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
