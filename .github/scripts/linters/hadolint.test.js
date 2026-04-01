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
} = require("./cargo-linter-test-lib");

const scriptPath = path.join(__dirname, "hadolint.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createCurlStub(binDir) {
	writeExecutable(
		path.join(binDir, "curl"),
		`#!/usr/bin/env bash
set -euo pipefail
out_file=""
write_format=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -w)
      write_format="$2"
      shift 2
      ;;
    -f|-s|-S|-L|-fsSL)
      shift
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\\n' "$url" >> "$CURL_URL_LOG"
if [ "$url" = "https://github.com/hadolint/hadolint/releases/latest" ]; then
  if [ -n "$out_file" ] && [ "$out_file" != "/dev/null" ]; then
    : > "$out_file"
  fi
  if [ "$write_format" = "%{url_effective}" ]; then
    printf '%s' "\${HADOLINT_RELEASE_URL:-https://github.com/hadolint/hadolint/releases/tag/v9.9.9}"
  fi
  exit 0
fi
cat > "$out_file" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
`,
	);
}

function createHadolintStub(binDir) {
	writeExecutable(
		path.join(binDir, "hadolint"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HADOLINT_ARGS_LOG"
target="\${*: -1}"
printf 'checked %s\\n' "$target"
if [ -n "\${FAIL_TARGET:-}" ] && [ "$target" = "$FAIL_TARGET" ]; then
  printf 'issue in %s\\n' "$target" >&2
  exit 1
fi
`,
	);
}

test("hadolint.sh patterns match Dockerfile and Containerfile naming conventions", () => {
	const output = execFileSync("bash", [scriptPath, "patterns"], {
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
	assert.equal(matches("docs/container-guide.txt"), false);
	assert.equal(matches(".dockerignore"), false);
});

test("hadolint.sh install downloads the latest Linux x86_64 release binary", () => {
	const context = makeTempRepo("hadolint-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");

	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [scriptPath, "install"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CURL_URL_LOG: curlUrlLog,
				HADOLINT_RELEASE_URL:
					"https://github.com/hadolint/hadolint/releases/tag/v2.14.0",
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			"https://github.com/hadolint/hadolint/releases/latest",
			"https://github.com/hadolint/hadolint/releases/download/v2.14.0/hadolint-linux-x86_64",
		]);
		assert.equal(
			fs.existsSync(path.join(context.runnerTemp, "hadolint/bin/hadolint")),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("hadolint.sh selects the nearest hadolint config for each target file", () => {
	const context = makeTempRepo("hadolint-config-search-");
	const hadolintArgsLog = path.join(context.tempDir, "hadolint-args.log");

	createHadolintStub(context.binDir);

	writeFile(path.join(context.repoDir, ".hadolint.yml"), "ignored: [DL3008]\n");
	writeFile(path.join(context.repoDir, "Dockerfile"), "FROM alpine:3.20\n");
	writeFile(
		path.join(context.repoDir, "services/api/.hadolint.yaml"),
		"ignored: [DL3007]\n",
	);
	writeFile(
		path.join(context.repoDir, "services/api/Dockerfile.dev"),
		"FROM alpine:3.20\n",
	);
	writeFile(
		path.join(context.repoDir, "containers/base.containerfile"),
		"FROM alpine:3.20\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[
				scriptPath,
				"run",
				"Dockerfile",
				"services/api/Dockerfile.dev",
				"containers/base.containerfile",
			],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					HADOLINT_ARGS_LOG: hadolintArgsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(hadolintArgsLog, "utf8").trim().split("\n"),
			[
				"--no-color --config .hadolint.yml Dockerfile",
				"--no-color --config services/api/.hadolint.yaml services/api/Dockerfile.dev",
				"--no-color --config .hadolint.yml containers/base.containerfile",
			],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("hadolint.sh omits --config when no repository config is found", () => {
	const context = makeTempRepo("hadolint-no-config-");
	const hadolintArgsLog = path.join(context.tempDir, "hadolint-args.log");

	createHadolintStub(context.binDir);
	writeFile(path.join(context.repoDir, "Dockerfile"), "FROM alpine:3.20\n");

	try {
		const output = execFileSync("bash", [scriptPath, "run", "Dockerfile"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				HADOLINT_ARGS_LOG: hadolintArgsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(
			fs.readFileSync(hadolintArgsLog, "utf8").trim(),
			"--no-color Dockerfile",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("hadolint.sh continues linting later files after one file fails", () => {
	const context = makeTempRepo("hadolint-continue-after-failure-");
	const hadolintArgsLog = path.join(context.tempDir, "hadolint-args.log");

	createHadolintStub(context.binDir);

	writeFile(
		path.join(context.repoDir, ".hadolint.yaml"),
		"ignored: [DL3008]\n",
	);
	writeFile(path.join(context.repoDir, "Dockerfile"), "FROM alpine:3.20\n");
	writeFile(
		path.join(context.repoDir, "services/api/Containerfile"),
		"FROM alpine:3.20\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "Dockerfile", "services/api/Containerfile"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					FAIL_TARGET: "Dockerfile",
					HADOLINT_ARGS_LOG: hadolintArgsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(hadolintArgsLog, "utf8").trim().split("\n"),
			[
				"--no-color --config .hadolint.yaml Dockerfile",
				"--no-color --config .hadolint.yaml services/api/Containerfile",
			],
		);
		assert.match(result.details, /issue in Dockerfile/);
		assert.match(result.details, /checked services\/api\/Containerfile/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
