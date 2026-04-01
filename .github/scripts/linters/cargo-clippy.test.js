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
    manifest=""
    prev=""
    is_clippy=0
    work_mount_src=""
    for arg in "$@"; do
      if [ "$prev" = "--manifest-path" ]; then
        manifest="$arg"
      fi
      if [ "$prev" = "cargo" ] && [ "$arg" = "clippy" ]; then
        is_clippy=1
      fi
      if [ "$prev" = "--mount" ]; then
        case "$arg" in
          *"dst=/work"*|*"target=/work"*)
            work_mount_src="\${arg#*src=}"
            work_mount_src="\${work_mount_src%%,*}"
            ;;
        esac
      fi
      prev="$arg"
    done
    printf '%s\\n' "$*" >> "$DOCKER_RUN_ARGS_LOG"
    if [ -n "$work_mount_src" ]; then
      if [ -e "$work_mount_src/.git" ]; then
        printf 'present\\n' >> "$WORKTREE_GIT_LOG"
      else
        printf 'absent\\n' >> "$WORKTREE_GIT_LOG"
      fi
    fi
    if [ "$is_clippy" -eq 1 ]; then
      printf '%s\\n' "$manifest" >> "$DOCKER_MANIFEST_LOG"
      printf 'checked %s\\n' "$manifest"
    else
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
		dockerImageInspectLog: path.join(
			context.tempDir,
			"docker-image-inspect.log",
		),
		dockerManifestLog: path.join(context.tempDir, "docker-manifests.log"),
		dockerRunArgsLog: path.join(context.tempDir, "docker-run-args.log"),
		dockerfileCopy: path.join(context.tempDir, "Dockerfile.copy"),
		worktreeGitLog: path.join(context.tempDir, "worktree-git.log"),
	};

	createDockerStub(context.binDir);

	return {
		...tooling,
		env: {
			DOCKER_BUILD_ARGS_LOG: tooling.dockerBuildArgsLog,
			DOCKER_IMAGE_INSPECT_LOG: tooling.dockerImageInspectLog,
			DOCKER_MANIFEST_LOG: tooling.dockerManifestLog,
			DOCKER_RUN_ARGS_LOG: tooling.dockerRunArgsLog,
			DOCKERFILE_COPY: tooling.dockerfileCopy,
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
		assert.equal(result.exit_code, 0);
		assert.equal(fs.existsSync(path.join(context.repoDir, ".git/HEAD")), true);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/cargo fetch --manifest-path Cargo\.toml/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs \/tmp/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/--user \d+:\d+/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/--network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.match(
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/CARGO_HOME=\/cargo-home/,
		);
		assert.deepEqual(
			fs.readFileSync(tooling.worktreeGitLog, "utf8").trim().split("\n"),
			["absent", "absent", "absent", "absent"],
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
			fs.readFileSync(tooling.dockerRunArgsLog, "utf8"),
			/--network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm cargo clippy --manifest-path crates\/member\/Cargo\.toml --all-targets -- -D warnings/,
		);
	},
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
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /fetch failure Cargo\.toml/);
		assert.match(runArgs, /cargo fetch --manifest-path Cargo\.toml/);
		assert.doesNotMatch(
			runArgs,
			/--network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.match(
			runArgs,
			/cargo fetch --manifest-path crates\/member\/Cargo\.toml/,
		);
		assert.match(
			runArgs,
			/--network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm cargo clippy --manifest-path crates\/member\/Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
