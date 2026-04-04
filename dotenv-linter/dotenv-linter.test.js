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

const patternsPath = path.join(__dirname, "patterns.sh");
const installPath = path.join(__dirname, "install.sh");
const runPath = path.join(__dirname, "run.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createReleaseAsset(assetPath) {
	const assetDir = path.join(path.dirname(assetPath), "asset");

	fs.mkdirSync(assetDir, { recursive: true });
	writeExecutable(
		path.join(assetDir, "dotenv-linter"),
		"#!/usr/bin/env bash\nexit 0\n",
	);
	execFileSync("tar", ["-czf", assetPath, "-C", assetDir, "dotenv-linter"]);
}

function createCurlStub(binDir) {
	writeExecutable(
		path.join(binDir, "curl"),
		`#!/usr/bin/env bash
	set -euo pipefail
	out_file=""
	url=""
	while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out_file="$2"
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
	cp "$DOTENV_LINTER_ASSET_SOURCE" "$out_file"
`,
	);
}

function createDotenvLinterStub(binDir) {
	writeExecutable(
		path.join(binDir, "dotenv-linter"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOTENV_LINTER_ARGS_LOG"
printf 'linted %s\\n' "$*"
for arg in "$@"; do
  if [ -n "\${FAIL_TARGET:-}" ] && [ "$arg" = "$FAIL_TARGET" ]; then
    printf 'issue in %s\\n' "$arg" >&2
    exit 1
  fi
done
`,
	);
}

test("dotenv-linter.sh patterns match .env-prefixed files", () => {
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

	assert.equal(matches(".env"), true);
	assert.equal(matches(".env.example"), true);
	assert.equal(matches("config/.env.production.local"), true);
	assert.equal(matches(".envrc"), false);
	assert.equal(matches("docs/env.md"), false);
	assert.equal(matches("config/app.env"), false);
});

test("dotenv-linter.sh install downloads the pinned Linux x86_64 release archive", () => {
	const context = makeTempRepo("dotenv-linter-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const version = readPinnedVersion(installPath, "dotenv_linter_version");
	const assetName = "dotenv-linter-linux-x86_64.tar.gz";
	const assetPath = path.join(context.tempDir, assetName);

	createReleaseAsset(assetPath);
	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CURL_URL_LOG: curlUrlLog,
				DOTENV_LINTER_ASSET_SOURCE: assetPath,
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			`https://github.com/dotenv-linter/dotenv-linter/releases/download/${version}/${assetName}`,
		]);
		assert.equal(
			fs.existsSync(
				path.join(context.runnerTemp, "dotenv-linter/bin/dotenv-linter"),
			),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("dotenv-linter.sh run passes changed files directly to dotenv-linter check", () => {
	const context = makeTempRepo("dotenv-linter-run-");
	const argsLog = path.join(context.tempDir, "dotenv-linter-args.log");

	createDotenvLinterStub(context.binDir);
	writeFile(path.join(context.repoDir, ".env"), "FOO=BAR\n");
	writeFile(path.join(context.repoDir, ".env.example"), "BAR=BAZ\n");

	try {
		const output = execFileSync("bash", [runPath, ".env", ".env.example"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				DOTENV_LINTER_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(
			fs.readFileSync(argsLog, "utf8").trim(),
			"check --plain --skip-updates .env .env.example",
		);
		assert.match(
			result.details,
			/linted check --plain --skip-updates \.env \.env\.example/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
