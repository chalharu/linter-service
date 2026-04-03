const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const installPath = path.join(__dirname, "install.sh");
const patternsPath = path.join(__dirname, "patterns.sh");
const runPath = path.join(__dirname, "run.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
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
  pull)
    printf '%s\\n' "$*" >> "$DOCKER_PULL_ARGS_LOG"
    ;;
  run)
    printf '%s\\n' "$*" >> "$DOCKER_RUN_ARGS_LOG"
    image_ref=""
    option_with_value=""
    command_args=()
    for arg in "$@"; do
      if [ -n "$option_with_value" ]; then
        option_with_value=""
        continue
      fi
      case "$arg" in
        --mount|--workdir|--user|--tmpfs|--security-opt|--cap-drop|--env|-e|--platform)
          option_with_value="$arg"
          continue
          ;;
        --rm|--read-only|--network=*)
          continue
          ;;
      esac
      if [ -z "$image_ref" ]; then
        image_ref="$arg"
        continue
      fi
      command_args+=("$arg")
    done
    if [ "\${#command_args[@]}" -eq 0 ]; then
      exit 0
    fi
    if [ "\${command_args[0]}" = "config" ]; then
      if [ -n "\${TRIVY_STDOUT:-}" ]; then
        printf '%s' "$TRIVY_STDOUT"
      fi
      if [ -n "\${TRIVY_STDERR:-}" ]; then
        printf '%s' "$TRIVY_STDERR" >&2
      fi
      exit "\${TRIVY_EXIT_CODE:-0}"
    fi
    echo "unsupported docker run command: \${command_args[*]}" >&2
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

test("trivy patterns match Dockerfile and Containerfile naming conventions", () => {
	const output = execFileSync("bash", [patternsPath], {
		encoding: "utf8",
	});
	const patterns = output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((pattern) => new RegExp(pattern, "i"));

	const matches = (filePath) =>
		patterns.some((pattern) => pattern.test(filePath));

	assert.equal(matches("Dockerfile"), true);
	assert.equal(matches("Dockerfile.dev"), true);
	assert.equal(matches("containers/Containerfile"), true);
	assert.equal(matches("containers/base.containerfile"), true);
	assert.equal(matches("docker/api.dockerfile"), true);
	assert.equal(matches("docs/docker-guide.md"), false);
	assert.equal(matches(".dockerignore"), false);
});

test("trivy install pulls the pinned Trivy image when it is missing", () => {
	const context = makeTempRepo("trivy-install-");
	const imageInspectLog = path.join(
		context.tempDir,
		"docker-image-inspect.log",
	);
	const pullArgsLog = path.join(context.tempDir, "docker-pull-args.log");

	createDockerStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				DOCKER_IMAGE_INSPECT_LOG: imageInspectLog,
				DOCKER_PULL_ARGS_LOG: pullArgsLog,
				MISSING_IMAGE: "1",
			}),
		});

		assert.match(
			fs.readFileSync(imageInspectLog, "utf8"),
			/ghcr\.io\/aquasecurity\/trivy:0\.69\.3@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689/u,
		);
		assert.match(
			fs.readFileSync(pullArgsLog, "utf8"),
			/--platform linux\/amd64 ghcr\.io\/aquasecurity\/trivy:0\.69\.3@sha256:7228e304ae0f610a1fad937baa463598cadac0c2ac4027cc68f3a8b997115689/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("trivy run scans a temp workspace with least-privilege container flags", () => {
	const context = makeTempRepo("trivy-run-");
	const runArgsLog = path.join(context.tempDir, "docker-run-args.log");
	const imageInspectLog = path.join(
		context.tempDir,
		"docker-image-inspect.log",
	);
	const pullArgsLog = path.join(context.tempDir, "docker-pull-args.log");

	createDockerStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "trivy.yml"),
		"scan:\\n  skip-dirs: []\\n",
	);
	writeFile(path.join(context.repoDir, ".trivyignore"), "DS-9999\n");
	writeFile(path.join(context.repoDir, "Dockerfile"), "FROM ubuntu:latest\n");

	try {
		const output = execFileSync("bash", [runPath, "Dockerfile"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				DOCKER_IMAGE_INSPECT_LOG: imageInspectLog,
				DOCKER_PULL_ARGS_LOG: pullArgsLog,
				DOCKER_RUN_ARGS_LOG: runArgsLog,
				TRIVY_EXIT_CODE: "1",
				TRIVY_STDOUT: JSON.stringify({
					Results: [
						{
							Target: "Dockerfile",
							Misconfigurations: [
								{
									ID: "DS-0001",
									Message:
										"Specify a tag in the 'FROM' statement for image 'ubuntu'",
									Severity: "MEDIUM",
									CauseMetadata: {
										StartLine: 1,
									},
								},
							],
						},
					],
				}),
			}),
		});
		const result = JSON.parse(output);
		const runArgs = fs.readFileSync(runArgsLog, "utf8");

		assert.equal(result.exit_code, 1);
		assert.match(
			result.details,
			/Dockerfile:1:1: warning DS-0001 \(MEDIUM\): Specify a tag/u,
		);
		assert.match(runArgs, /--platform linux\/amd64/u);
		assert.match(runArgs, /--cap-drop ALL/u);
		assert.match(runArgs, /--security-opt no-new-privileges/u);
		assert.match(runArgs, /--read-only/u);
		assert.match(runArgs, /--tmpfs \/tmp/u);
		assert.match(runArgs, /--network=none/u);
		assert.match(runArgs, /--config trivy\.yml/u);
		assert.match(runArgs, /--skip-check-update/u);
		assert.match(runArgs, /--format json/u);
		assert.match(runArgs, /\/work/u);
		assert.equal(
			fs.existsSync(
				path.join(
					context.runnerTemp,
					"trivy-workspace",
					"source",
					".trivyignore",
				),
			),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
