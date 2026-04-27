#!/usr/bin/env bash

linter_lib::add_path() {
  local path_entry=$1

  mkdir -p "$path_entry"
  if [ -n "${GITHUB_PATH:-}" ]; then
    printf '%s\n' "$path_entry" >> "$GITHUB_PATH"
  else
    export PATH="$path_entry:$PATH"
  fi
}

linter_lib::python_cmd() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' python3
    return 0
  fi

  if command -v python >/dev/null 2>&1; then
    printf '%s\n' python
    return 0
  fi

  echo "python3 or python is required" >&2
  return 1
}

linter_lib::copy_first_existing_path() {
  local target_root=$1
  shift

  local candidate
  for candidate in "$@"; do
    if [ -f "$candidate" ]; then
      local destination="$target_root/$candidate"
      mkdir -p "$(dirname "$destination")"
      cp "$candidate" "$destination"
      return 0
    fi
  done

  return 1
}

linter_lib::copy_paths_to_root() {
  local target_root=$1
  shift

  local path
  for path in "$@"; do
    local destination="$target_root/$path"
    mkdir -p "$(dirname "$destination")"
    cp "$path" "$destination"
  done
}

linter_lib::copy_worktree_without_git() {
  local target_root=$1
  local source_root=${2:-.}

  rm -rf "$target_root"
  mkdir -p "$target_root"
  tar --exclude=.git -C "$source_root" -cf - . | tar -xf - -C "$target_root"
}

linter_lib::find_cargo_manifest() {
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

linter_lib::workspace_manifest_from_metadata() {
  local source_root=$1

  node -e '
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = process.argv[1];
const data = JSON.parse(fs.readFileSync(0, "utf8"));

if (typeof data.workspace_root !== "string" || data.workspace_root.length === 0) {
  process.exit(1);
}

const manifestPath = path.join(data.workspace_root, "Cargo.toml");
const relativePath = path.relative(sourceRoot, manifestPath);

if (relativePath.length === 0) {
  process.stdout.write("Cargo.toml");
  process.exit(0);
}

if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
  process.exit(1);
}

process.stdout.write(relativePath.split(path.sep).join("/"));
  ' "$source_root"
}

linter_lib::resolve_cargo_workspace_manifest() {
  local source_root=$1
  local manifest_path=$2
  shift 2

  local metadata_json relative_manifest

  if ! metadata_json="$("$@" metadata --format-version 1 --no-deps --manifest-path "$manifest_path" 2>/dev/null)"; then
    printf '%s\n' "$manifest_path"
    return 0
  fi

  if ! relative_manifest="$(
    printf '%s' "$metadata_json" | linter_lib::workspace_manifest_from_metadata "$source_root"
  )"; then
    printf '%s\n' "$manifest_path"
    return 0
  fi

  printf '%s\n' "$relative_manifest"
}

linter_lib::collect_cargo_manifests() {
  local output_file=$1
  local tool_name=$2
  local manifests_var=$3
  shift 3

  local -n manifests_ref="$manifests_var"
  local -A seen_manifests=()
  local missing_files=()
  local path manifest_path

  manifests_ref=()

  for path in "$@"; do
    if ! manifest_path=$(linter_lib::find_cargo_manifest "$path"); then
      missing_files+=("$path")
      continue
    fi

    if [ -z "${seen_manifests[$manifest_path]+x}" ]; then
      seen_manifests["$manifest_path"]=1
      manifests_ref+=("$manifest_path")
    fi
  done

  if [ "${#missing_files[@]}" -gt 0 ]; then
    {
      printf '%s requires each selected file to belong to a Cargo package.\n' "$tool_name"
      echo "No Cargo.toml found for:"
      for path in "${missing_files[@]}"; do
        printf ' - %s\n' "$path"
      done
    } > "$output_file"
    return 1
  fi

  return 0
}

linter_lib::collect_cargo_relevant_dirs() {
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

linter_lib::find_preferred_cargo_config_in_dir() {
  local dir=$1
  local candidate

  for candidate in \
    "$dir/.cargo/config" \
    "$dir/.cargo/config.toml"
  do
    if [ -f "$candidate" ]; then
      printf '%s\n' "${candidate#./}"
      return 0
    fi
  done

  return 1
}

linter_lib::collect_cargo_config_paths() {
  local manifest_path=$1
  local current_dir config_path
  local collected_paths=()
  local index

  current_dir=$(dirname "$manifest_path")
  while :; do
    if config_path=$(linter_lib::find_preferred_cargo_config_in_dir "$current_dir"); then
      collected_paths+=("$config_path")
    fi

    if [ "$current_dir" = "." ] || [ "$current_dir" = "/" ]; then
      break
    fi

    current_dir=$(dirname "$current_dir")
  done

  for ((index=${#collected_paths[@]} - 1; index >= 0; index--)); do
    printf '%s\n' "${collected_paths[$index]}"
  done
}

linter_lib::cargo_config_chain_key() {
  local manifest_path=$1
  local key=""
  local config_path

  while IFS= read -r config_path; do
    if [ -n "$config_path" ]; then
      key+="${key:+$'\x1f'}$config_path"
    fi
  done < <(linter_lib::collect_cargo_config_paths "$manifest_path")

  printf '%s\n' "$key"
}

linter_lib::cargo_workdir_for_manifest() {
  local manifest_path=$1
  local manifest_dir

  manifest_dir=$(dirname "$manifest_path")
  if [ "$manifest_dir" = "." ]; then
    printf '%s\n' /work
    return 0
  fi

  printf '/work/%s\n' "$manifest_dir"
}

linter_lib::relative_repo_path() {
  local from_dir=$1
  local target_path=$2

  node - "$from_dir" "$target_path" <<'NODE'
const path = require("node:path");

const [fromDir, targetPath] = process.argv.slice(2);
process.stdout.write(path.relative(fromDir, targetPath).split(path.sep).join("/"));
NODE
}

linter_lib::relative_repo_path_from_manifest_dir() {
  local manifest_path=$1
  local target_path=$2

  linter_lib::relative_repo_path "$(dirname "$manifest_path")" "$target_path"
}

linter_lib::validate_network_safe_cargo_config() {
  local manifest_path=$1
  local python_bin
  local config_paths=()

  mapfile -t config_paths < <(linter_lib::collect_cargo_config_paths "$manifest_path")
  if [ "${#config_paths[@]}" -eq 0 ]; then
    return 0
  fi

  if [ -x /usr/bin/python3 ]; then
    python_bin=/usr/bin/python3
  else
    python_bin=$(linter_lib::python_cmd) || return 1
  fi
  "$python_bin" - "${config_paths[@]}" <<'PY'
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError as exc:
    print(f"error: {exc}", file=sys.stderr)
    print(
        "python 3.11+ with tomllib is required to validate repo-local Cargo config safely",
        file=sys.stderr,
    )
    sys.exit(1)

ALLOWED_TOP_LEVEL_KEYS = {
    "build",
    "doc",
    "future-incompat-report",
    "profile",
    "term",
}

ALLOWED_BUILD_KEYS = {
    "build-dir",
    "dep-info-basedir",
    "incremental",
    "jobs",
    "target-dir",
}
ALLOWED_DOC_KEYS = {"browser"}
ALLOWED_FUTURE_INCOMPAT_REPORT_KEYS = {"frequency"}
ALLOWED_TERM_KEYS = {
    "color",
    "hyperlinks",
    "progress",
    "quiet",
    "unicode",
    "verbose",
}
ALLOWED_TERM_PROGRESS_KEYS = {"term-integration", "when", "width"}

top_level_violations = []
nested_violations = []


def record_nested_violations(raw_path: str, names: list[str]) -> None:
    if names:
        nested_violations.append((raw_path, sorted(names)))


def validate_build_table(raw_path: str, table: object) -> None:
    if not isinstance(table, dict):
        record_nested_violations(raw_path, ["build"])
        return
    record_nested_violations(
        raw_path,
        [f"build.{key}" for key in table.keys() if key not in ALLOWED_BUILD_KEYS],
    )


def validate_doc_table(raw_path: str, table: object) -> None:
    if not isinstance(table, dict):
        record_nested_violations(raw_path, ["doc"])
        return
    record_nested_violations(
        raw_path,
        [f"doc.{key}" for key in table.keys() if key not in ALLOWED_DOC_KEYS],
    )


def validate_future_incompat_report_table(raw_path: str, table: object) -> None:
    if not isinstance(table, dict):
        record_nested_violations(raw_path, ["future-incompat-report"])
        return
    record_nested_violations(
        raw_path,
        [
            f"future-incompat-report.{key}"
            for key in table.keys()
            if key not in ALLOWED_FUTURE_INCOMPAT_REPORT_KEYS
        ],
    )


def validate_term_table(raw_path: str, table: object) -> None:
    if not isinstance(table, dict):
        record_nested_violations(raw_path, ["term"])
        return

    violations = []
    for key, value in table.items():
        if key not in ALLOWED_TERM_KEYS:
            violations.append(f"term.{key}")
            continue
        if key != "progress":
            continue
        if not isinstance(value, dict):
            violations.append("term.progress")
            continue
        for nested_key in value.keys():
            if nested_key not in ALLOWED_TERM_PROGRESS_KEYS:
                violations.append(f"term.progress.{nested_key}")
    record_nested_violations(raw_path, violations)

for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - surfaced in shell tests
        print(
            f"repo-local Cargo config cannot be used for networked resolution because {raw_path} could not be parsed: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)

    unsupported = sorted(
        key
        for key in data.keys()
        if key not in ALLOWED_TOP_LEVEL_KEYS
    )
    if unsupported:
        top_level_violations.append((raw_path, unsupported))
        continue

    if "build" in data:
        validate_build_table(raw_path, data["build"])
    if "doc" in data:
        validate_doc_table(raw_path, data["doc"])
    if "future-incompat-report" in data:
        validate_future_incompat_report_table(
            raw_path,
            data["future-incompat-report"],
        )
    if "term" in data:
        validate_term_table(raw_path, data["term"])

if top_level_violations or nested_violations:
    allowed = ", ".join(sorted(ALLOWED_TOP_LEVEL_KEYS))
    print(
        "repo-local Cargo config for networked resolution is restricted on the shared runner.",
        file=sys.stderr,
    )
    print(
        f"Allowed top-level sections: {allowed}",
        file=sys.stderr,
    )
    print(
        "Allowed nested settings: build.{build-dir,dep-info-basedir,incremental,jobs,target-dir}, "
        "doc.browser, future-incompat-report.frequency, "
        "term.{color,hyperlinks,quiet,unicode,verbose}, "
        "term.progress.{term-integration,when,width}",
        file=sys.stderr,
    )
    for raw_path, unsupported in top_level_violations:
        print(
            f" - {raw_path}: unsupported top-level section(s): {', '.join(unsupported)}",
            file=sys.stderr,
        )
    for raw_path, unsupported in nested_violations:
        print(
            f" - {raw_path}: unsupported setting(s): {', '.join(unsupported)}",
            file=sys.stderr,
        )
    print(
        "Network, source, registry, and credential-related repo config must not be trusted during shared cargo resolution.",
        file=sys.stderr,
    )
    sys.exit(1)
PY
}

linter_lib::emit_json_result() {
  local exit_code=$1
  local output_file=$2
  local python_bin

  if python_bin="$(linter_lib::python_cmd 2>/dev/null)"; then
    "$python_bin" - "$exit_code" "$output_file" <<'PY'
import json
import sys
from pathlib import Path

exit_code = int(sys.argv[1])
output_path = Path(sys.argv[2])
details = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
print(json.dumps({"details": details, "exit_code": exit_code}))
PY
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");

const [exitCodeRaw, outputPath] = process.argv.slice(2);
const details =
  outputPath && fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8").trim()
    : "";
process.stdout.write(
  JSON.stringify({
    details,
    exit_code: Number.parseInt(exitCodeRaw, 10),
  }),
);
NODE
    return 0
  fi

  echo "python3, python, or node is required" >&2
  return 1
}

linter_lib::emit_json_result_with_json_file() {
  local exit_code=$1
  local result_key=$2
  local json_file=$3
  local python_bin

  if [ ! -f "$json_file" ]; then
    printf 'JSON file not found: %s\n' "$json_file" >&2
    return 1
  fi

  if python_bin="$(linter_lib::python_cmd 2>/dev/null)"; then
    "$python_bin" - "$exit_code" "$result_key" "$json_file" <<'PY'
import json
import sys
from pathlib import Path

exit_code = int(sys.argv[1])
result_key = sys.argv[2]
json_path = Path(sys.argv[3])

payload = {"exit_code": exit_code, result_key: json.loads(json_path.read_text(encoding="utf-8"))}
print(json.dumps(payload))
PY
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$exit_code" "$result_key" "$json_file" <<'NODE'
const fs = require("node:fs");

const [exitCodeRaw, resultKey, jsonPath] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
process.stdout.write(
  JSON.stringify({
    exit_code: Number.parseInt(exitCodeRaw, 10),
    [resultKey]: payload,
  }),
);
NODE
    return 0
  fi

  echo "python3, python, or node is required" >&2
  return 1
}

linter_lib::emit_json_result_with_sarif() {
  local exit_code=$1
  local sarif_file=$2

  linter_lib::emit_json_result_with_json_file "$exit_code" sarif "$sarif_file"
}

linter_lib::emit_json_result_with_sarif_findings() {
  local sarif_file=$1
  local python_bin

  if [ ! -f "$sarif_file" ]; then
    printf 'JSON file not found: %s\n' "$sarif_file" >&2
    return 1
  fi

  if python_bin="$(linter_lib::python_cmd 2>/dev/null)"; then
    "$python_bin" - "$sarif_file" <<'PY'
import json
import sys
from pathlib import Path

sarif_path = Path(sys.argv[1])
payload = json.loads(sarif_path.read_text(encoding="utf-8"))
has_results = any(len(run.get("results", [])) > 0 for run in payload.get("runs", []))
print(json.dumps({"exit_code": 1 if has_results else 0, "sarif": payload}))
PY
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$sarif_file" <<'NODE'
const fs = require("node:fs");

const sarifPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(sarifPath, "utf8"));
const hasResults = (payload?.runs ?? []).some((run) => (run?.results?.length ?? 0) > 0);
process.stdout.write(
  JSON.stringify({
    exit_code: hasResults ? 1 : 0,
    sarif: payload,
  }),
);
NODE
    return 0
  fi

  echo "python3, python, or node is required" >&2
  return 1
}

linter_lib::run_and_emit_json() {
  local output_file=$1
  shift
  local exit_code

  set +e
  "$@" >"$output_file" 2>&1
  exit_code=$?
  set -e

  linter_lib::emit_json_result "$exit_code" "$output_file"
}

linter_lib::install_node_tools() {
  local prefix_dir=$1
  shift

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install Node.js-based linters" >&2
    return 1
  fi

  mkdir -p "$prefix_dir"
  npm install --global --prefix "$prefix_dir" "$@" >/dev/null
  linter_lib::add_path "$prefix_dir/bin"
}

linter_lib::install_python_tools() {
  local venv_dir=$1
  shift
  local python_bin

  python_bin=$(linter_lib::python_cmd)

  "$python_bin" -m venv "$venv_dir"
  "$venv_dir/bin/pip" install --disable-pip-version-check --upgrade pip "$@" >/dev/null
  linter_lib::add_path "$venv_dir/bin"
}
