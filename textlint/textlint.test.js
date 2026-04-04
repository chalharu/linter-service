const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	readPinnedVersion,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const {
	loadStaticTextlintConfig,
	getTextlintPresetRuleKey,
	resolveTextlintRuntime,
} = require("./textlint-config.js");

const installPath = path.join(__dirname, "install.sh");
const runPath = path.join(__dirname, "run.sh");

function createScriptEnv(context, extraEnv = {}) {
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
  build)
    printf '%s\\n' "$*" >> "$DOCKER_BUILD_ARGS_LOG"
    context="\${*: -1}"
    cp "$context/Dockerfile" "$DOCKERFILE_COPY"
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
        --mount|--workdir|--user|--tmpfs|--security-opt|--cap-drop|--env|-e)
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
    if [ "\${command_args[0]}" = "npm" ] && [ "\${command_args[1]}" = "install" ]; then
      printf '%s\\n' "\${command_args[*]}" >> "$DOCKER_NPM_INSTALL_LOG"
      exit 0
    fi
    if [ "\${command_args[0]}" = "textlint" ]; then
      printf '%s\\n' "\${command_args[*]}" >> "$DOCKER_TEXTLINT_ARGS_LOG"
      if [ -n "\${TEXTLINT_STDOUT:-}" ]; then
        printf '%s' "$TEXTLINT_STDOUT"
      fi
      exit "\${TEXTLINT_EXIT_CODE:-0}"
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

test("getTextlintPresetRuleKey converts package names to textlint preset rule keys", () => {
	assert.equal(
		getTextlintPresetRuleKey("textlint-rule-preset-ja-technical-writing"),
		"preset-ja-technical-writing",
	);
	assert.equal(
		getTextlintPresetRuleKey("@textlint-ja/textlint-rule-preset-ai-writing"),
		"@textlint-ja/preset-ai-writing",
	);
});

test("resolveTextlintRuntime injects configured preset packages into a safe config copy", () => {
	const context = makeTempRepo("textlint-config-");
	const outputPath = path.join(context.tempDir, "safe", ".textlintrc");

	writeFile(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				linters: {
					textlint: {
						disabled: false,
						preset_packages: [
							"textlint-rule-preset-ja-technical-writing@12.0.2",
							"@textlint-ja/textlint-rule-preset-ai-writing@1.6.1",
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFile(
		path.join(context.repoDir, ".textlintrc"),
		JSON.stringify(
			{
				rules: {
					"preset-ja-technical-writing": {
						"sentence-length": {
							max: 140,
						},
					},
				},
			},
			null,
			2,
		),
	);

	try {
		const runtime = resolveTextlintRuntime({
			outputPath,
			repositoryPath: context.repoDir,
		});

		assert.deepEqual(runtime.presetPackages, [
			{
				name: "textlint-rule-preset-ja-technical-writing",
				spec: "textlint-rule-preset-ja-technical-writing@12.0.2",
				version: "12.0.2",
			},
			{
				name: "@textlint-ja/textlint-rule-preset-ai-writing",
				spec: "@textlint-ja/textlint-rule-preset-ai-writing@1.6.1",
				version: "1.6.1",
			},
		]);
		assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
			rules: {
				"@textlint-ja/preset-ai-writing": true,
				"preset-ja-technical-writing": {
					"sentence-length": {
						max: 140,
					},
				},
			},
		});
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("loadStaticTextlintConfig rejects non-JSON .textlintrc content", () => {
	const context = makeTempRepo("textlint-config-invalid-");
	const configPath = path.join(context.repoDir, ".textlintrc");

	writeFile(configPath, "module.exports = {};\n");

	try {
		assert.throws(
			() => loadStaticTextlintConfig({ configPath }),
			/static JSON/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("textlint install builds a dedicated container image when missing", () => {
	const context = makeTempRepo("textlint-install-");
	const version = readPinnedVersion(installPath, "textlint_version");
	const dockerBuildArgsLog = path.join(
		context.tempDir,
		"docker-build-args.log",
	);
	const dockerImageInspectLog = path.join(
		context.tempDir,
		"docker-image-inspect.log",
	);
	const dockerRunArgsLog = path.join(context.tempDir, "docker-run-args.log");
	const dockerNpmInstallLog = path.join(
		context.tempDir,
		"docker-npm-install.log",
	);
	const dockerTextlintArgsLog = path.join(
		context.tempDir,
		"docker-textlint-args.log",
	);
	const dockerfileCopy = path.join(context.tempDir, "Dockerfile.copy");

	createDockerStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createScriptEnv(context, {
				DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
				DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
				DOCKER_NPM_INSTALL_LOG: dockerNpmInstallLog,
				DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
				DOCKER_TEXTLINT_ARGS_LOG: dockerTextlintArgsLog,
				DOCKERFILE_COPY: dockerfileCopy,
				MISSING_IMAGE: "1",
			}),
		});

		assert.match(
			fs.readFileSync(dockerImageInspectLog, "utf8"),
			/localhost\/linter-service-textlint:node-24-bookworm/u,
		);
		assert.match(
			fs.readFileSync(dockerBuildArgsLog, "utf8"),
			/--pull --tag localhost\/linter-service-textlint:node-24-bookworm/u,
		);
		assert.match(
			fs.readFileSync(dockerfileCopy, "utf8"),
			/FROM docker\.io\/library\/node:24-bookworm/u,
		);
		assert.match(fs.readFileSync(dockerfileCopy, "utf8"), /--ignore-scripts/u);
		assert.match(
			fs.readFileSync(dockerfileCopy, "utf8"),
			/--min-release-age=3/u,
		);
		assert.match(
			fs.readFileSync(dockerfileCopy, "utf8"),
			new RegExp(`textlint@${version.replaceAll(".", "\\.")}`, "u"),
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("textlint run installs hardened preset packages and uses the merged safe config in a container", () => {
	const context = makeTempRepo("textlint-run-");
	const dockerBuildArgsLog = path.join(
		context.tempDir,
		"docker-build-args.log",
	);
	const dockerImageInspectLog = path.join(
		context.tempDir,
		"docker-image-inspect.log",
	);
	const dockerRunArgsLog = path.join(context.tempDir, "docker-run-args.log");
	const dockerNpmInstallLog = path.join(
		context.tempDir,
		"docker-npm-install.log",
	);
	const dockerTextlintArgsLog = path.join(
		context.tempDir,
		"docker-textlint-args.log",
	);
	const dockerfileCopy = path.join(context.tempDir, "Dockerfile.copy");

	createDockerStub(context.binDir);
	writeFile(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				linters: {
					textlint: {
						disabled: false,
						preset_packages: [
							"textlint-rule-preset-ja-technical-writing@12.0.2",
							"@textlint-ja/textlint-rule-preset-ai-writing@1.6.1",
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFile(
		path.join(context.repoDir, ".textlintrc"),
		JSON.stringify(
			{
				rules: {
					"preset-ja-technical-writing": {
						"sentence-length": {
							max: 140,
						},
					},
				},
			},
			null,
			2,
		),
	);
	writeFile(path.join(context.repoDir, "README.md"), "これはテストです！\n");

	try {
		const output = execFileSync("bash", [runPath, "README.md"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createScriptEnv(context, {
				DOCKER_BUILD_ARGS_LOG: dockerBuildArgsLog,
				DOCKER_IMAGE_INSPECT_LOG: dockerImageInspectLog,
				DOCKER_NPM_INSTALL_LOG: dockerNpmInstallLog,
				DOCKER_RUN_ARGS_LOG: dockerRunArgsLog,
				DOCKER_TEXTLINT_ARGS_LOG: dockerTextlintArgsLog,
				DOCKERFILE_COPY: dockerfileCopy,
				TEXTLINT_EXIT_CODE: "1",
				TEXTLINT_STDOUT:
					"/work/README.md:1:1: sample diagnostic [Error/example]\\n",
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /^README\.md:1:1: sample diagnostic/mu);
		assert.match(
			fs.readFileSync(dockerNpmInstallLog, "utf8"),
			/npm install --prefix \/rules --ignore-scripts --loglevel=error --no-audit --no-fund --no-save --package-lock=false --update-notifier=false --min-release-age 3 textlint-rule-preset-ja-technical-writing@12\.0\.2 @textlint-ja\/textlint-rule-preset-ai-writing@1\.6\.1/u,
		);
		assert.match(fs.readFileSync(dockerRunArgsLog, "utf8"), /--network=none/u);
		assert.doesNotMatch(
			fs.readFileSync(dockerTextlintArgsLog, "utf8"),
			/--preset/u,
		);
		assert.deepEqual(
			JSON.parse(
				fs.readFileSync(
					path.join(context.runnerTemp, "textlint", "repo", ".textlintrc"),
					"utf8",
				),
			),
			{
				rules: {
					"@textlint-ja/preset-ai-writing": true,
					"preset-ja-technical-writing": {
						"sentence-length": {
							max: 140,
						},
					},
				},
			},
		);
		assert.match(
			fs.readFileSync(dockerTextlintArgsLog, "utf8"),
			/--rules-base-directory \/rules\/node_modules/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
