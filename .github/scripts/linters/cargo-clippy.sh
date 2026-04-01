#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../linter-library.sh
source "$script_dir/../linter-library.sh"

cargo_clippy_base_image() {
  printf '%s\n' "${CARGO_CLIPPY_BASE_IMAGE:-docker.io/library/rust:1-bookworm}"
}

cargo_clippy_image_ref() {
  printf '%s\n' "${CARGO_CLIPPY_IMAGE_REF:-localhost/linter-service-cargo-clippy:rust-1-bookworm}"
}

cargo_clippy_require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run cargo-clippy in an isolated container" >&2
    return 1
  fi
}

cargo_clippy_collect_relevant_dirs() {
  local -A seen=()
  local manifest_path current_dir

  seen["."]=1
  printf '%s\n' "."

  for manifest_path in "$@"; do
    current_dir=$(dirname "$manifest_path")

    while :; do
      if [ -z "${seen[$current_dir]+x}" ]; then
        seen["$current_dir"]=1
        printf '%s\n' "$current_dir"
      fi

      if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
        break
      fi

      current_dir=$(dirname "$current_dir")
    done
  done
}

cargo_clippy_find_unsupported_config() {
  local dir candidate

  for dir in "$@"; do
    for candidate in \
      "$dir/.cargo/config.toml" \
      "$dir/.cargo/config"
    do
      if [ -f "$candidate" ]; then
        printf '%s\n' "${candidate#./}"
        return 0
      fi
    done
  done

  return 1
}

mode=${1-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$mode" in
  patterns)
    cat <<'EOF'
\.(?:rs)$
EOF
    ;;
  install)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_clippy_require_docker

    image_ref=$(cargo_clippy_image_ref)
    base_image=$(cargo_clippy_base_image)
    build_context="$RUNNER_TEMP/cargo-clippy-image"

    if docker image inspect "$image_ref" >/dev/null 2>&1; then
      exit 0
    fi

    rm -rf "$build_context"
    mkdir -p "$build_context"

    cat > "$build_context/Dockerfile" <<EOF
FROM ${base_image}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates git \\
 && rm -rf /var/lib/apt/lists/* \\
 && rustup component add clippy
EOF

    docker build \
      --pull \
      --tag "$image_ref" \
      "$build_context"
    ;;
  run)
    : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
    cargo_clippy_require_docker
    output_file="$RUNNER_TEMP/linter-output.txt"
    manifests=()
    relevant_dirs=()
    unsupported_config=""
    if ! linter_lib::collect_cargo_manifests "$output_file" "Cargo clippy" manifests "$@"; then
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi
    mapfile -t relevant_dirs < <(cargo_clippy_collect_relevant_dirs "${manifests[@]}")
    if unsupported_config="$(cargo_clippy_find_unsupported_config "${relevant_dirs[@]}")"; then
      cat > "$output_file" <<EOF
Repository-supplied \`$unsupported_config\` is not supported in this shared linter service because \`cargo fetch\` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.
Use the default Cargo registry configuration for the shared \`cargo-clippy\` path.
EOF
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    workspace_root="$RUNNER_TEMP/cargo-clippy-workspace"
    source_root="$workspace_root/source"
    cargo_home="$workspace_root/cargo-home"
    rustup_root="$workspace_root/rustup-home"
    target_root="$workspace_root/cargo-target"
    image_ref=$(cargo_clippy_image_ref)
    user_id=$(id -u)
    group_id=$(id -g)

    rm -rf "$workspace_root"
    mkdir -p "$cargo_home" "$rustup_root" "$target_root"
    linter_lib::copy_worktree_without_git "$source_root"

    cleanup_workspace() {
      rm -rf "$workspace_root"
    }

    trap cleanup_workspace EXIT

    seed_writable_rustup_home() {
      if [ -f "$rustup_root/settings.toml" ]; then
        return 0
      fi

      printf '==> docker run seed writable rustup home\n'
      docker run \
        --rm \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --read-only \
        --tmpfs /tmp \
        --user "$user_id:$group_id" \
        --mount "type=bind,src=$rustup_root,dst=/rustup-home" \
        "$image_ref" \
        sh -ceu 'tar -C /usr/local/rustup -cf - . | tar -xf - -C /rustup-home'
      echo
    }

    docker_run_common=(
      --rm
      --cap-drop ALL
      --security-opt no-new-privileges
      --read-only
      --tmpfs /tmp
      --user "$user_id:$group_id"
      --workdir /work
      --mount "type=bind,src=$source_root,dst=/work"
      --mount "type=bind,src=$cargo_home,dst=/cargo-home"
      --mount "type=bind,src=$rustup_root,dst=/usr/local/rustup"
      --mount "type=bind,src=$target_root,dst=/cargo-target"
      --env CARGO_HOME=/cargo-home
      --env CARGO_TARGET_DIR=/cargo-target
      --env CARGO_TERM_COLOR=never
      --env HOME=/cargo-home
    )

    run_cargo_clippy() {
      local failure=0
      local current_manifest
      local fetch_failures_path="$cargo_home/fetch-failed-manifests.txt"
      local clippy_manifests=()
      local -A failed_fetches=()

      if ! seed_writable_rustup_home; then
        return 1
      fi

      rm -f "$fetch_failures_path"

      if ! docker run \
        "${docker_run_common[@]}" \
        --env LINTER_SERVICE_BATCH_MODE=fetch \
        "$image_ref" \
        sh -ceu '
          failed_path=/cargo-home/fetch-failed-manifests.txt
          : > "$failed_path"
          for manifest_path in "$@"; do
            printf "==> docker run cargo fetch --manifest-path %s\n" "$manifest_path"
            if ! cargo fetch --manifest-path "$manifest_path"; then
              printf "%s\n" "$manifest_path" >> "$failed_path"
            fi
            echo
          done
        ' sh "${manifests[@]}"; then
        return 1
      fi

      if [ -s "$fetch_failures_path" ]; then
        failure=1
        while IFS= read -r current_manifest; do
          if [ -n "$current_manifest" ]; then
            failed_fetches["$current_manifest"]=1
          fi
        done < "$fetch_failures_path"
      fi

      for current_manifest in "${manifests[@]}"; do
        if [ -n "${failed_fetches[$current_manifest]+x}" ]; then
          printf '==> skip cargo clippy --manifest-path %s because cargo fetch failed\n\n' "$current_manifest"
          continue
        fi
        clippy_manifests+=("$current_manifest")
      done

      if [ "${#clippy_manifests[@]}" -eq 0 ]; then
        return "$failure"
      fi

      if ! docker run \
        "${docker_run_common[@]}" \
        --env LINTER_SERVICE_BATCH_MODE=clippy \
        --network=none \
        "$image_ref" \
        sh -ceu '
          failure=0
          for manifest_path in "$@"; do
            printf "==> docker run cargo clippy --manifest-path %s --all-targets -- -D warnings\n" "$manifest_path"
            if ! cargo clippy --manifest-path "$manifest_path" --all-targets -- -D warnings; then
              failure=1
            fi
            echo
          done
          exit "$failure"
        ' sh "${clippy_manifests[@]}"; then
        failure=1
      fi

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_cargo_clippy
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
