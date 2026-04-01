const test = require("node:test");
const {
	assert,
	cleanupTempRepo,
	defineCommonCargoManifestTests,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("./cargo-linter-test-lib");

const { execFileSync } = require("node:child_process");

const scriptPath = path.join(__dirname, "cargo-clippy.sh");

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
    context="\${*: -1}"
    cp "$context/Dockerfile" "$DOCKERFILE_COPY"
    ;;
  run)
    cargo_home_mount_src=""
    command_args=()
    image_ref=""
    manifest=""
    prev=""
    is_clippy=0
    is_rustup_seed=0
    has_rustup_runtime_mount=0
    option_with_value=""
    work_mount_src=""
    batch_mode=""
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
              *"dst=/usr/local/rustup"*|*"target=/usr/local/rustup"*)
                has_rustup_runtime_mount=1
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
      if [ "$prev" = "cargo" ] && [ "$arg" = "clippy" ]; then
        is_clippy=1
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
      : > "$RUSTUP_STATE_FILE"
      exit 0
    fi
    if [ -n "$work_mount_src" ]; then
      if [ -e "$work_mount_src/.git" ]; then
        printf 'present\\n' >> "$WORKTREE_GIT_LOG"
      else
        printf 'absent\\n' >> "$WORKTREE_GIT_LOG"
      fi
    fi
    if [ -n "\${REQUIRE_WRITABLE_RUSTUP_HOME:-}" ] && { [ "$has_rustup_runtime_mount" -ne 1 ] || [ ! -f "$RUSTUP_STATE_FILE" ]; }; then
      printf 'info: syncing channel updates for 1.94-x86_64-unknown-linux-gnu\\n' >&2
      printf 'error: could not create temp file /usr/local/rustup/tmp/test_file: Read-only file system (os error 30)\\n' >&2
      exit 1
    fi
    if [ -n "$batch_mode" ]; then
      batch_manifests=()
      if [ "\${#command_args[@]}" -ge 4 ] && [ "\${command_args[0]}" = "sh" ] && [ "\${command_args[1]}" = "-ceu" ] && [ "\${command_args[3]}" = "sh" ]; then
        batch_manifests=("\${command_args[@]:4}")
      fi
      if [ "$batch_mode" = "fetch" ]; then
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
      failure=0
      for manifest in "\${batch_manifests[@]}"; do
        printf '%s\\n' "$manifest" >> "$DOCKER_MANIFEST_LOG"
        printf '==> docker run cargo clippy --manifest-path %s --all-targets -- -D warnings\\n' "$manifest"
        printf 'checked %s\\n' "$manifest"
        if [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ]; then
          printf 'clippy failure %s\\n' "$manifest" >&2
          failure=1
        fi
        echo
      done
      exit "$failure"
    fi
    if [ "$is_clippy" -eq 1 ]; then
      printf '%s\\n' "$manifest" >> "$DOCKER_MANIFEST_LOG"
      printf 'checked %s\\n' "$manifest"
    else
      printf '%s\\n' "$manifest" >> "$DOCKER_FETCH_MANIFEST_LOG"
      printf 'prefetched %s\\n' "$manifest"
      if [ -n "\${FAIL_FETCH_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_FETCH_MANIFEST" ]; then
        printf 'fetch failure %s\\n' "$manifest" >&2
        exit 1
      fi
    fi
    if [ "$is_clippy" -eq 1 ] && [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ]; then
      printf 'clippy failure %s\\n' "$manifest" >&2
      exit 1
    fi
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
		dockerfileCopy: path.join(context.tempDir, "Dockerfile.copy"),
		rustupStateFile: path.join(context.tempDir, "rustup-state"),
		worktreeGitLog: path.join(context.tempDir, "worktree-git.log"),
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
			DOCKERFILE_COPY: tooling.dockerfileCopy,
			RUSTUP_STATE_FILE: tooling.rustupStateFile,
			WORKTREE_GIT_LOG: tooling.worktreeGitLog,
		},
	};
}

test("cargo-clippy.sh install builds a dedicated clippy container image when missing", () => {
	const context = makeTempRepo("cargo-clippy-install-");
	const tooling = setupDockerTooling(context);

	try {
		execFileSync("bash", [scriptPath, "install"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				CARGO_CLIPPY_BASE_IMAGE: "docker.io/library/rust:1-bookworm",
				CARGO_CLIPPY_IMAGE_REF: "localhost/test/cargo-clippy:latest",
				MISSING_IMAGE: "1",
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});

		assert.match(
			fs.readFileSync(tooling.dockerImageInspectLog, "utf8"),
			/localhost\/test\/cargo-clippy:latest/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerBuildArgsLog, "utf8"),
			/--pull --tag localhost\/test\/cargo-clippy:latest/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerfileCopy, "utf8"),
			/FROM docker\.io\/library\/rust:1-bookworm/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerfileCopy, "utf8"),
			/rustup component add clippy/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

defineCommonCargoManifestTests({
	scriptPath,
	tempPrefix: "cargo-clippy-",
	toolName: "cargo-clippy.sh",
	setupTooling: setupDockerTooling,
	assertGroupedResult({ context, result, tooling }) {
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.equal(fs.existsSync(path.join(context.repoDir, ".git/HEAD")), true);
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
		assert.match(
			runArgs,
			/--env LINTER_SERVICE_BATCH_MODE=fetch localhost\/linter-service-cargo-clippy:rust-1-bookworm sh -ceu/,
		);
		assert.match(
			runArgs,
			/--env LINTER_SERVICE_BATCH_MODE=clippy --network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm sh -ceu/,
		);
		assert.match(
			runArgs,
			/--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs \/tmp/,
		);
		assert.match(runArgs, /--user \d+:\d+/);
		assert.match(runArgs, /CARGO_HOME=\/cargo-home/);
		assert.match(runArgs, /dst=\/usr\/local\/rustup/);
		assert.deepEqual(
			fs.readFileSync(tooling.worktreeGitLog, "utf8").trim().split("\n"),
			["absent", "absent"],
		);
		assert.match(
			result.details,
			/docker run cargo fetch --manifest-path Cargo\.toml/,
		);
		assert.match(
			result.details,
			/docker run cargo clippy --manifest-path Cargo\.toml/,
		);
	},
	assertMissingManifestResult({ pathValue, result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(
			result.details,
			new RegExp(pathValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.equal(fs.existsSync(tooling.dockerManifestLog), false);
		assert.equal(fs.existsSync(tooling.dockerRunArgsLog), false);
		assert.equal(fs.existsSync(tooling.worktreeGitLog), false);
	},
	continueFailureEnv: {
		FAIL_MANIFEST: "Cargo.toml",
	},
	assertContinueAfterFailureResult({ result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(result.details, /clippy failure Cargo\.toml/);
		assert.match(
			result.details,
			/docker run cargo clippy --manifest-path crates\/member\/Cargo\.toml --all-targets -- -D warnings/,
		);
	},
});

test("cargo-clippy.sh seeds writable rustup state before cargo fetch", () => {
	const context = makeTempRepo("cargo-clippy-rustup-home-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "rust-toolchain.toml"),
		`[toolchain]
channel = "1.94"
`,
	);

	try {
		const output = execFileSync("bash", [scriptPath, "run", "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				REQUIRE_WRITABLE_RUSTUP_HOME: "1",
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.equal(fs.existsSync(tooling.rustupStateFile), true);
		assert.match(
			runArgs,
			/sh -ceu tar -C \/usr\/local\/rustup -cf - \. \| tar -xf - -C \/rustup-home/,
		);
		assert.match(runArgs, /dst=\/rustup-home/);
		assert.match(runArgs, /dst=\/usr\/local\/rustup/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-clippy.sh rejects repository-supplied Cargo config on the shared path", () => {
	const context = makeTempRepo("cargo-clippy-unsafe-config-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		`[registries.private]
index = "sparse+https://example.invalid/index/"
`,
	);

	try {
		const output = execFileSync("bash", [scriptPath, "run", "src/lib.rs"], {
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
			/Repository-supplied `\.cargo\/config\.toml` is not supported/,
		);
		assert.equal(fs.existsSync(tooling.dockerRunArgsLog), false);
		assert.equal(fs.existsSync(tooling.dockerManifestLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-clippy.sh skips clippy for a package when cargo fetch fails and continues with later packages", () => {
	const context = makeTempRepo("cargo-clippy-fetch-failure-");
	const tooling = setupDockerTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					...tooling.env,
					FAIL_FETCH_MANIFEST: "Cargo.toml",
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /fetch failure Cargo\.toml/);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.doesNotMatch(
			result.details,
			/docker run cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.match(
			result.details,
			/docker run cargo fetch --manifest-path crates\/member\/Cargo\.toml/,
		);
		assert.match(
			result.details,
			/docker run cargo clippy --manifest-path crates\/member\/Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
