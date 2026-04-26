const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
	assert,
	cleanupTempRepo,
	defineCommonCargoManifestTests,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const installPath = path.join(__dirname, "install.sh");
const runPath = path.join(__dirname, "run.sh");

const SHORT_SYMBOL = "short_fn";
const LONG_SYMBOL = "a".repeat(1025);

function createDockerStub(binDir) {
	writeExecutable(
		path.join(binDir, "docker"),
		`#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift

case "$command" in
  image)
    subcommand="$1"
    shift
    if [ "$subcommand" != "inspect" ]; then
      echo "unsupported docker image subcommand: $subcommand" >&2
      exit 1
    fi
    printf '%s\\n' "$*" >> "$DOCKER_IMAGE_INSPECT_LOG"
    if [ -n "\${MISSING_IMAGE:-}" ]; then
      exit 1
    fi
    ;;
  build)
    printf '%s\\n' "$*" >> "$DOCKER_BUILD_ARGS_LOG"
    ;;
  run)
    cargo_home_mount_src=""
    image_ref=""
    run_entries_mount_src=""
    work_mount_src=""
    batch_mode=""
    command_args=()
    option_with_value=""
    is_rustup_seed=0
    is_metadata=0
    manifest=""
    prev=""

    for arg in "$@"; do
      if [ -n "$option_with_value" ]; then
        case "$option_with_value" in
          --mount)
            case "$arg" in
              *"dst=/work"*|*"target=/work"*)
                work_mount_src="\${arg#*src=}"
                work_mount_src="\${work_mount_src%%,*}"
                ;;
              *"dst=/cargo-home"*|*"target=/cargo-home"*)
                cargo_home_mount_src="\${arg#*src=}"
                cargo_home_mount_src="\${cargo_home_mount_src%%,*}"
                ;;
              *"dst=/run-entries"*|*"target=/run-entries"*)
                run_entries_mount_src="\${arg#*src=}"
                run_entries_mount_src="\${run_entries_mount_src%%,*}"
                ;;
            esac
            ;;
          --env|-e)
            case "$arg" in
              LINTER_SERVICE_BATCH_MODE=*)
                batch_mode="\${arg#LINTER_SERVICE_BATCH_MODE=}"
                ;;
            esac
            ;;
        esac
        option_with_value=""
        prev="$arg"
        continue
      fi
      case "$arg" in
        --mount|--user|--workdir|--tmpfs|--security-opt|--cap-drop|--env|-e)
          option_with_value="$arg"
          prev="$arg"
          continue
          ;;
        --rm|--read-only|--network=*)
          prev="$arg"
          continue
          ;;
      esac
      if [ -z "$image_ref" ]; then
        image_ref="$arg"
        prev="$arg"
        continue
      fi
      command_args+=("$arg")
      if [ "$prev" = "--manifest-path" ]; then
        manifest="$arg"
      fi
      if [ "$prev" = "cargo" ] && [ "$arg" = "metadata" ]; then
        is_metadata=1
      fi
      prev="$arg"
    done

    printf '%s\\n' "$*" >> "$DOCKER_RUN_ARGS_LOG"

    case "$*" in
      *"tar -C /usr/local/rustup -cf - . | tar -xf - -C /rustup-home"*)
        is_rustup_seed=1
        ;;
    esac

    if [ "$is_rustup_seed" -eq 1 ]; then
      mkdir -p "$RUSTUP_STATE_DIR"
      touch "$RUSTUP_STATE_DIR/settings.toml"
      exit 0
    fi

    if [ "$is_metadata" -eq 1 ]; then
      if [ -z "$manifest" ]; then
        echo "missing --manifest-path" >&2
        exit 1
      fi
      current_dir="$work_mount_src/$(dirname "$manifest")"
      workspace_dir="$current_dir"
      search_dir="$current_dir"
      while :; do
        candidate="$search_dir/Cargo.toml"
        if [ -f "$candidate" ] && grep -Eq '^\\[workspace\\]' "$candidate"; then
          workspace_dir="$search_dir"
          break
        fi
        if [ "$search_dir" = "$work_mount_src" ] || [ "$search_dir" = "/" ]; then
          break
        fi
        search_dir=$(dirname "$search_dir")
      done
      node - "$work_mount_src" "$workspace_dir" <<'NODE'
const path = require("node:path");
const [sourceRoot, workspaceDir] = process.argv.slice(2);
const relativeDir = path.relative(sourceRoot, workspaceDir);
const workspaceRoot =
  relativeDir.length === 0
    ? "/work"
    : path.posix.join("/work", ...relativeDir.split(path.sep));
process.stdout.write(JSON.stringify({ workspace_root: workspaceRoot }));
NODE
      exit 0
    fi

    if [ "$batch_mode" = "fetch" ]; then
      batch_manifests=()
      if [ "\${#command_args[@]}" -ge 4 ] && [ "\${command_args[0]}" = "sh" ] && [ "\${command_args[1]}" = "-ceu" ] && [ "\${command_args[3]}" = "sh" ]; then
        batch_manifests=("\${command_args[@]:4}")
      fi
      failed_file=""
      if [ -n "$cargo_home_mount_src" ]; then
        failed_file="$cargo_home_mount_src/fetch-failed-manifests.txt"
        : > "$failed_file"
      fi
      for manifest in "\${batch_manifests[@]}"; do
        printf '%s\\n' "$manifest" >> "$DOCKER_FETCH_MANIFEST_LOG"
        printf '==> docker run cargo fetch --manifest-path %s\\n' "$manifest"
        printf 'prefetched %s\\n' "$manifest"
        if [ -n "\${FAIL_FETCH_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_FETCH_MANIFEST" ]; then
          if [ -n "$failed_file" ]; then
            printf '%s\\n' "$manifest" >> "$failed_file"
          fi
          printf 'fetch failure %s\\n' "$manifest" >&2
        fi
        echo
      done
      exit 0
    fi

    # python3 /linter/scan.py MANIFEST... (--network=none)
    if [ "\${command_args[0]:-}" = "python3" ] && [ "\${command_args[1]:-}" = "/linter/scan.py" ]; then
      scan_manifests=("\${command_args[@]:2}")
      failure=0
      run_index=0
      for manifest in "\${scan_manifests[@]}"; do
        run_index=$((run_index + 1))
        run_dir=""
        if [ -n "$run_entries_mount_src" ]; then
          run_dir=$(printf '%s/%04d' "$run_entries_mount_src" "$run_index")
          mkdir -p "$run_dir"
        fi
        printf '%s\\n' "$manifest" >> "$DOCKER_MANIFEST_LOG"

        package_name=$(node - "$work_mount_src/$manifest" <<'NODE'
const fs = require("node:fs");
const [manifestPath] = process.argv.slice(2);
let name = "";
for (const line of fs.readFileSync(manifestPath, "utf8").split("\\n")) {
  if (line.startsWith("name = ")) {
    name = line.split("=", 2)[1].trim().replace(/^"|"$/g, "");
    break;
  }
}
process.stdout.write(name);
NODE
)
        manifest_dir=$(dirname "$work_mount_src/$manifest")
        src_path="src/lib.rs"
        if [ ! -f "$manifest_dir/src/lib.rs" ] && [ -f "$manifest_dir/src/main.rs" ]; then
          src_path="src/main.rs"
          target_kind="bin"
        else
          target_kind="lib"
        fi

        cmd="cargo rustc --manifest-path $manifest --$target_kind -- --emit=obj -o /cargo-target/symbol-scan-$run_index.o"
        run_exit=0

        if [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ]; then
          run_exit=1
          failure=1
          symbols=""
          stderr_text="error: could not compile $package_name due to previous error"
        elif [[ "$package_name" == *fail* ]] || [ -n "\${LONG_SYMBOLS:-}" ]; then
          symbols="$LONG_SYMBOL_LENGTH\\t$LONG_SYMBOL_VALUE"
          stderr_text="   Compiling $package_name v0.1.0 (/work)\\n    Finished [unoptimized]"
        else
          symbols="$SHORT_SYMBOL_LENGTH\\t$SHORT_SYMBOL_VALUE"
          stderr_text="   Compiling $package_name v0.1.0 (/work)\\n    Finished [unoptimized]"
        fi

        if [ -n "$run_dir" ]; then
          printf '%s\\n' "$cmd" > "$run_dir/command.txt"
          printf '%s\\n' "$manifest" > "$run_dir/manifest_path.txt"
          printf '%s\\n' "$target_kind" > "$run_dir/target_kind.txt"
          printf '%s\\n' "$package_name" > "$run_dir/target_name.txt"
          printf '%s\\n' "$src_path" > "$run_dir/target_src_path.txt"
          printf '%s\\n' "$run_exit" > "$run_dir/exit_code.txt"
          printf '' > "$run_dir/stdout.txt"
          printf '%b\\n' "$stderr_text" > "$run_dir/stderr.txt"
          printf '%b\\n' "$symbols" > "$run_dir/symbols.txt"
        fi

        printf 'cargo rustc --manifest-path %s\\n' "$manifest"
        printf '%b\\n' "$stderr_text"
      done
      exit "$failure"
    fi

    echo "unsupported docker run invocation: $*" >&2
    exit 1
    ;;
  *)
    echo "unsupported docker command: $command" >&2
    exit 1
    ;;
esac
`,
	);
}

function setupDockerTooling(context) {
	writeFile(path.join(context.repoDir, ".git/HEAD"), "ref: refs/heads/test\n");

	const tooling = {
		dockerBuildArgsLog: path.join(context.tempDir, "docker-build-args.log"),
		dockerFetchManifestLog: path.join(
			context.tempDir,
			"docker-fetch-manifests.log",
		),
		dockerImageInspectLog: path.join(
			context.tempDir,
			"docker-image-inspect.log",
		),
		dockerManifestLog: path.join(context.tempDir, "docker-manifests.log"),
		dockerRunArgsLog: path.join(context.tempDir, "docker-run-args.log"),
		rustupStateDir: path.join(context.tempDir, "rustup-state"),
	};

	createDockerStub(context.binDir);

	return {
		...tooling,
		env: {
			DOCKER_BUILD_ARGS_LOG: tooling.dockerBuildArgsLog,
			DOCKER_FETCH_MANIFEST_LOG: tooling.dockerFetchManifestLog,
			DOCKER_IMAGE_INSPECT_LOG: tooling.dockerImageInspectLog,
			DOCKER_MANIFEST_LOG: tooling.dockerManifestLog,
			DOCKER_RUN_ARGS_LOG: tooling.dockerRunArgsLog,
			LONG_SYMBOL_LENGTH: String(LONG_SYMBOL.length),
			LONG_SYMBOL_VALUE: LONG_SYMBOL,
			RUSTUP_STATE_DIR: tooling.rustupStateDir,
			SHORT_SYMBOL_LENGTH: String(SHORT_SYMBOL.length),
			SHORT_SYMBOL_VALUE: SHORT_SYMBOL,
		},
	};
}

defineCommonCargoManifestTests({
	runPath,
	tempPrefix: "cargo-symbol-length-",
	toolName: "cargo-symbol-length.sh",
	setupTooling: setupDockerTooling,
	assertGroupedResult({ result, tooling }) {
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(runArgs, /python3 \/linter\/scan\.py/);
		assert.match(runArgs, /--network=none/);
		assert.match(runArgs, /--read-only/);
		assert.match(runArgs, /--tmpfs \/tmp/);
		assert.match(runArgs, /dst=\/run-entries/);
		assert.match(runArgs, /dst=\/linter\/scan\.py/);
	},
	assertMissingManifestResult({ pathValue, result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(
			result.details,
			new RegExp(pathValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.equal(fs.existsSync(tooling.dockerManifestLog), false);
	},
	continueFailureEnv: {
		FAIL_MANIFEST: "Cargo.toml",
	},
	assertContinueAfterFailureResult({ result }) {
		assert.equal(result.exit_code, 1);
	},
});

test("cargo-symbol-length.sh detects symbols exceeding max_symbol_length", () => {
	const context = makeTempRepo("cargo-symbol-length-findings-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "fixture-fail"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(
		path.join(context.repoDir, "src/lib.rs"),
		`#[no_mangle] pub extern "C" fn ${LONG_SYMBOL}() {}\n`,
	);

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.cargo_symbol_length_runs.length, 1);
		assert.equal(result.cargo_symbol_length_runs[0].findings.length, 1);
		assert.equal(result.cargo_symbol_length_runs[0].findings[0].length, 1025);
		assert.match(result.details, /Found 1 symbol\(s\) with length >= 1024/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-symbol-length.sh passes when all symbols are below threshold", () => {
	const context = makeTempRepo("cargo-symbol-length-pass-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "fixture-pass"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn hello() {}\n");

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(result.cargo_symbol_length_runs[0].findings.length, 0);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-symbol-length.sh honors repository-configured max_symbol_length", () => {
	const context = makeTempRepo("cargo-symbol-length-config-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "fixture-pass"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn hello() {}\n");
	// Set a very low threshold so the short symbol trips it
	writeFile(
		path.join(context.repoDir, ".github/linter-service.yaml"),
		"linters:\n  cargo-symbol-length:\n    max_symbol_length: 3\n",
	);

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		// SHORT_SYMBOL = "short_fn" (8 chars) >= 3 → should be flagged
		assert.equal(result.exit_code, 1);
		assert.equal(result.cargo_symbol_length_runs[0].findings.length, 1);
		assert.equal(result.cargo_symbol_length_runs[0].findings[0].length, 8);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-symbol-length.sh rejects repository-supplied .cargo/config.toml", () => {
	const context = makeTempRepo("cargo-symbol-length-cargo-config-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn hello() {}\n");
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		"[net]\nretry = 3\n",
	);

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(
			result.details,
			/not supported in this shared linter service/u,
		);
		assert.equal(fs.existsSync(tooling.dockerManifestLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
