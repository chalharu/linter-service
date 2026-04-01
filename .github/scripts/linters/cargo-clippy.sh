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

cargo_clippy_find_manifest() {
  local path=$1
  local current_dir candidate

  current_dir=$(dirname "$path")
  while :; do
    candidate="$current_dir/Cargo.toml"
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
    missing_files=()
    declare -A seen_manifests=()
    path=""
    manifest_path=""

    for path in "$@"; do
      if ! manifest_path=$(cargo_clippy_find_manifest "$path"); then
        missing_files+=("$path")
        continue
      fi

      if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
        seen_manifests["$manifest_path"]=1
        manifests+=("$manifest_path")
      fi
    done

    if [ "${#missing_files[@]}" -gt 0 ]; then
      {
        echo "Cargo clippy requires each selected Rust file to belong to a Cargo package."
        echo "No Cargo.toml found for:"
        for path in "${missing_files[@]}"; do
          printf ' - %s\n' "$path"
        done
      } > "$output_file"
      linter_lib::emit_json_result 1 "$output_file"
      exit 0
    fi

    workspace_root="$RUNNER_TEMP/cargo-clippy-workspace"
    source_root="$workspace_root/source"
    cargo_home="$workspace_root/cargo-home"
    target_root="$workspace_root/cargo-target"
    image_ref=$(cargo_clippy_image_ref)
    user_id=$(id -u)
    group_id=$(id -g)

    rm -rf "$workspace_root"
    mkdir -p "$source_root" "$cargo_home" "$target_root"
    cp -a ./. "$source_root/"

    cleanup_workspace() {
      rm -rf "$workspace_root"
    }

    trap cleanup_workspace EXIT

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
      --mount "type=bind,src=$target_root,dst=/cargo-target"
      --env CARGO_HOME=/cargo-home
      --env CARGO_TARGET_DIR=/cargo-target
      --env CARGO_TERM_COLOR=never
      --env HOME=/cargo-home
    )

    run_cargo_clippy() {
      local failure=0
      local current_manifest

      for current_manifest in "${manifests[@]}"; do
        printf '==> docker run cargo fetch --manifest-path %s\n' "$current_manifest"
        if ! docker run \
          "${docker_run_common[@]}" \
          "$image_ref" \
          cargo fetch --manifest-path "$current_manifest"; then
          failure=1
          echo
          continue
        fi

        printf '==> docker run cargo clippy --manifest-path %s --all-targets -- -D warnings\n' "$current_manifest"
        if ! docker run \
          "${docker_run_common[@]}" \
          --network=none \
          "$image_ref" \
          cargo clippy --manifest-path "$current_manifest" --all-targets -- -D warnings; then
          failure=1
        fi
        echo
      done

      return "$failure"
    }

    linter_lib::run_and_emit_json "$output_file" run_cargo_clippy
    ;;
  *)
    echo "usage: $0 {patterns|install|run}" >&2
    exit 1
    ;;
esac
