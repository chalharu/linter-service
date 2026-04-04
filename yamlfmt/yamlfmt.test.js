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
		path.join(assetDir, "yamlfmt"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "-version" ]; then
  echo "yamlfmt version 0.0.0"
  exit 0
fi
exit 0
`,
	);
	execFileSync("tar", ["-czf", assetPath, "-C", assetDir, "yamlfmt"]);
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
	cp "$YAMLFMT_ASSET_SOURCE" "$out_file"
`,
	);
}

function createYamlfmtStub(binDir) {
	writeExecutable(
		path.join(binDir, "yamlfmt"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "-version" ]; then
  echo "yamlfmt version 0.0.0"
  exit 0
fi
lint_mode=0
if [ "\${1-}" = "-lint" ]; then
  lint_mode=1
fi
if [ "$lint_mode" -eq 1 ]; then
  printf '%s\\n' "$*" >> "$YAMLFMT_ARGS_LOG"
fi
if [ "$lint_mode" -eq 0 ]; then
  for arg in "$@"; do
    if [ -f "$arg" ]; then
      node - "$arg" <<'NODE'
const fs = require("node:fs");
const filePath = process.argv[2];
const content = fs.readFileSync(filePath, "utf8");
fs.writeFileSync(filePath, content.replace(/:  /g, ": "), "utf8");
NODE
    fi
  done
  exit 0
fi
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

test("yamlfmt.sh patterns match YAML files", () => {
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

	assert.equal(matches("config.yaml"), true);
	assert.equal(matches("config.yml"), true);
	assert.equal(matches("nested/app/settings.yaml"), true);
	assert.equal(matches("docs/yaml-guide.md"), false);
	assert.equal(matches("config.json"), false);
});

test("yamlfmt.sh install downloads the pinned Linux x86_64 release archive", () => {
	const context = makeTempRepo("yamlfmt-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const version = readPinnedVersion(installPath, "yamlfmt_version");
	const archiveVersion = version.replace(/^v/u, "");
	const assetPath = path.join(
		context.tempDir,
		`yamlfmt_${archiveVersion}_Linux_x86_64.tar.gz`,
	);

	createReleaseAsset(assetPath);
	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CURL_URL_LOG: curlUrlLog,
				YAMLFMT_ASSET_SOURCE: assetPath,
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			`https://github.com/google/yamlfmt/releases/download/${version}/yamlfmt_${archiveVersion}_Linux_x86_64.tar.gz`,
		]);
		assert.equal(
			fs.existsSync(path.join(context.runnerTemp, "yamlfmt/bin/yamlfmt")),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("yamlfmt.sh prefers the highest-priority repo config file", () => {
	const context = makeTempRepo("yamlfmt-config-priority-");
	const argsLog = path.join(context.tempDir, "yamlfmt-args.log");

	createYamlfmtStub(context.binDir);
	writeFile(
		path.join(context.repoDir, ".yamlfmt"),
		"formatter:\n  type: basic\n",
	);
	writeFile(
		path.join(context.repoDir, "yamlfmt.yaml"),
		"formatter:\n  type: kyaml\n",
	);
	writeFile(path.join(context.repoDir, "config/app.yaml"), "foo: bar\n");
	writeFile(path.join(context.repoDir, "deploy/service.yml"), "bar: baz\n");

	try {
		const output = execFileSync(
			"bash",
			[runPath, "config/app.yaml", "deploy/service.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					YAMLFMT_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(
			fs.readFileSync(argsLog, "utf8").trim(),
			"-lint -conf .yamlfmt config/app.yaml deploy/service.yml",
		);
		assert.match(
			result.details,
			/linted -lint -conf \.yamlfmt config\/app\.yaml deploy\/service\.yml/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("yamlfmt.sh falls back to a temp default config when the repo has none", () => {
	const context = makeTempRepo("yamlfmt-default-config-");
	const argsLog = path.join(context.tempDir, "yamlfmt-args.log");
	const defaultConfigPath = path.join(context.runnerTemp, "yamlfmt.yaml");

	createYamlfmtStub(context.binDir);
	writeFile(path.join(context.repoDir, "service.yaml"), "foo: bar\n");

	try {
		const output = execFileSync("bash", [runPath, "service.yaml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				YAMLFMT_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(
			fs.readFileSync(argsLog, "utf8").trim(),
			`-lint -conf ${defaultConfigPath} service.yaml`,
		);
		assert.equal(
			fs.readFileSync(defaultConfigPath, "utf8"),
			"formatter:\n  type: basic\n",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("yamlfmt.sh reports yamlfmt failures for selected files", () => {
	const context = makeTempRepo("yamlfmt-failure-");
	const argsLog = path.join(context.tempDir, "yamlfmt-args.log");

	createYamlfmtStub(context.binDir);
	writeFile(
		path.join(context.repoDir, ".yamlfmt.yml"),
		"formatter:\n  type: basic\n",
	);
	writeFile(path.join(context.repoDir, "valid.yaml"), "foo: bar\n");
	writeFile(
		path.join(context.repoDir, "needs-format.yml"),
		[
			"service:",
			"  name: demo",
			"  metadata:",
			"    owner: platform",
			"    labels:",
			"      env: dev",
			"      team:  core",
			"  enabled: true",
			"",
		].join("\n"),
	);

	try {
		const output = execFileSync(
			"bash",
			[runPath, "valid.yaml", "needs-format.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					FAIL_TARGET: "needs-format.yml",
					YAMLFMT_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(
			fs.readFileSync(argsLog, "utf8").trim(),
			"-lint -conf .yamlfmt.yml valid.yaml needs-format.yml",
		);
		assert.match(
			result.details,
			/needs-format\.yml:7: yamlfmt would reformat this file/,
		);
		assert.match(result.details, /issue in needs-format\.yml/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
