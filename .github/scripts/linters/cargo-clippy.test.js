const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const scriptPath = path.join(__dirname, "cargo-clippy.sh");

function writeExecutable(filePath, content) {
	fs.writeFileSync(filePath, content, "utf8");
	fs.chmodSync(filePath, 0o755);
}

function createPythonStub(binDir) {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
exit_code="$2"
output_file="$3"
node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");
const [exitCode, outputFile] = process.argv.slice(2);
const details = fs.existsSync(outputFile)
\t? fs.readFileSync(outputFile, "utf8").trim()
\t: "";
process.stdout.write(JSON.stringify({ details, exit_code: Number(exitCode) }));
NODE
`,
	);
}

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
    for arg in "$@"; do
      if [ "$prev" = "--manifest-path" ]; then
        manifest="$arg"
      fi
      if [ "$prev" = "cargo" ] && [ "$arg" = "clippy" ]; then
        is_clippy=1
      fi
      prev="$arg"
    done
    printf '%s\\n' "$*" >> "$DOCKER_RUN_ARGS_LOG"
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

function makeTempRepo(prefix) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const repoDir = path.join(tempDir, "repo");
	const runnerTemp = path.join(tempDir, "runner");
	const binDir = path.join(tempDir, "bin");
	const dockerBuildArgsLog = path.join(tempDir, "docker-build-args.log");
	const dockerImageInspectLog = path.join(tempDir, "docker-image-inspect.log");
	const dockerManifestLog = path.join(tempDir, "docker-manifests.log");
	const dockerRunArgsLog = path.join(tempDir, "docker-run-args.log");
	const dockerfileCopy = path.join(tempDir, "Dockerfile.copy");

	fs.mkdirSync(repoDir, { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });

	createPythonStub(binDir);
	createDockerStub(binDir);

	return {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	};
}

function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

test("cargo-clippy.sh install builds a dedicated clippy container image when missing", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-install-");

	try {
		execFileSync("bash", [scriptPath, "install"], {
			cwd: repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				CARGO_CLIPPY_BASE_IMAGE: "docker.io/library/rust:1-bookworm",
				CARGO_CLIPPY_IMAGE_REF: "localhost/test/cargo-clippy:latest",
				DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
				DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
				DOCKERFILE_COPY: dockerfileCopy,
				MISSING_IMAGE: "1",
				PATH: `${binDir}:${process.env.PATH}`,
				RUNNER_TEMP: runnerTemp,
			},
		});

		assert.match(
			fs.readFileSync(dockerImageInspectLog, "utf8"),
			/localhost\/test\/cargo-clippy:latest/,
		);
		assert.match(
			fs.readFileSync(dockerBuildArgsLog, "utf8"),
			/--pull --tag localhost\/test\/cargo-clippy:latest/,
		);
		assert.match(
			fs.readFileSync(dockerfileCopy, "utf8"),
			/FROM docker\.io\/library\/rust:1-bookworm/,
		);
		assert.match(
			fs.readFileSync(dockerfileCopy, "utf8"),
			/rustup component add clippy/,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-clippy.sh groups changed Rust files by nearest Cargo.toml", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-grouped-");

	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(path.join(repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[
				scriptPath,
				"run",
				"src/lib.rs",
				"src/main.rs",
				"crates/member/src/lib.rs",
			],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
					DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
					DOCKER_MANIFEST_LOG: dockerManifestLog,
					DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
					DOCKERFILE_COPY: dockerfileCopy,
					PATH: `${binDir}:${process.env.PATH}`,
					RUNNER_TEMP: runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(
			fs.readFileSync(dockerRunArgsLog, "utf8"),
			/cargo fetch --manifest-path Cargo\.toml/,
		);
		assert.match(
			fs.readFileSync(dockerRunArgsLog, "utf8"),
			/--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs \/tmp/,
		);
		assert.match(fs.readFileSync(dockerRunArgsLog, "utf8"), /--user \d+:\d+/);
		assert.match(
			fs.readFileSync(dockerRunArgsLog, "utf8"),
			/--network=none localhost\/linter-service-cargo-clippy:rust-1-bookworm cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
		);
		assert.match(
			fs.readFileSync(dockerRunArgsLog, "utf8"),
			/CARGO_HOME=\/cargo-home/,
		);
		assert.match(
			result.details,
			/docker run cargo clippy --manifest-path Cargo\.toml/,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-clippy.sh reports Rust files outside Cargo packages", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-missing-manifest-");

	writeFile(path.join(repoDir, "standalone.rs"), "fn main() {}\n");

	try {
		const output = execFileSync("bash", [scriptPath, "run", "standalone.rs"], {
			cwd: repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
				DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
				DOCKER_MANIFEST_LOG: dockerManifestLog,
				DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
				DOCKERFILE_COPY: dockerfileCopy,
				PATH: `${binDir}:${process.env.PATH}`,
				RUNNER_TEMP: runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(result.details, /standalone\.rs/);
		assert.equal(fs.existsSync(dockerManifestLog), false);
		assert.equal(fs.existsSync(dockerRunArgsLog), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-clippy.sh handles absolute Rust file paths outside Cargo packages", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-absolute-missing-manifest-");
	const standalonePath = path.join(tempDir, "standalone.rs");

	writeFile(standalonePath, "fn main() {}\n");

	try {
		const output = execFileSync("bash", [scriptPath, "run", standalonePath], {
			cwd: repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
				DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
				DOCKER_MANIFEST_LOG: dockerManifestLog,
				DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
				DOCKERFILE_COPY: dockerfileCopy,
				PATH: `${binDir}:${process.env.PATH}`,
				RUNNER_TEMP: runnerTemp,
			},
			timeout: 1000,
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(result.details, /standalone\.rs/);
		assert.equal(fs.existsSync(dockerManifestLog), false);
		assert.equal(fs.existsSync(dockerRunArgsLog), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-clippy.sh continues checking later Cargo packages after one failure", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-continue-");

	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
					DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
					DOCKER_MANIFEST_LOG: dockerManifestLog,
					DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
					DOCKERFILE_COPY: dockerfileCopy,
					FAIL_MANIFEST: "Cargo.toml",
					PATH: `${binDir}:${process.env.PATH}`,
					RUNNER_TEMP: runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(result.details, /clippy failure Cargo\.toml/);
		assert.match(
			fs.readFileSync(dockerRunArgsLog, "utf8"),
			/cargo clippy --manifest-path crates\/member\/Cargo\.toml --all-targets -- -D warnings/,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-clippy.sh skips clippy for a package when cargo fetch fails and continues with later packages", () => {
	const {
		binDir,
		dockerBuildArgsLog,
		dockerImageInspectLog,
		dockerManifestLog,
		dockerRunArgsLog,
		dockerfileCopy,
		repoDir,
		runnerTemp,
		tempDir,
	} = makeTempRepo("cargo-clippy-fetch-failure-");

	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
					DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
					DOCKER_MANIFEST_LOG: dockerManifestLog,
					DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
					DOCKERFILE_COPY: dockerfileCopy,
					FAIL_FETCH_MANIFEST: "Cargo.toml",
					PATH: `${binDir}:${process.env.PATH}`,
					RUNNER_TEMP: runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);
		const runArgs = fs.readFileSync(dockerRunArgsLog, "utf8");

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
			fs.readFileSync(dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
