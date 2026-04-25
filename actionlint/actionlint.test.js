const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const runPath = path.join(__dirname, "run.sh");
const commonPath = path.join(__dirname, "common.sh");
const linterLibraryPath = path.join(
	__dirname,
	"..",
	".github",
	"scripts",
	"linter-library.sh",
);
const bashPath = execFileSync("bash", ["-lc", "command -v bash"], {
	encoding: "utf8",
}).trim();
const expressionSnippet = "run: echo $" + "{{ bad";

function linkCommand(context, name) {
	const targetPath = path.join(context.binDir, name);
	if (fs.existsSync(targetPath)) {
		return;
	}

	const sourcePath = execFileSync("bash", ["-lc", `command -v ${name}`], {
		encoding: "utf8",
	}).trim();
	fs.symlinkSync(sourcePath, targetPath);
}

function createNodeOnlyEnv(context, extraEnv = {}) {
	fs.rmSync(path.join(context.binDir, "python3"), { force: true });
	fs.rmSync(path.join(context.binDir, "python"), { force: true });
	for (const tool of ["bash", "cat", "dirname", "node", "rm"]) {
		linkCommand(context, tool);
	}

	return {
		...process.env,
		...extraEnv,
		PATH: context.binDir,
		RUNNER_TEMP: context.runnerTemp,
	};
}

// Minimal well-formed SARIF with one result
const SARIF_WITH_RESULTS = JSON.stringify({
	$schema:
		"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	version: "2.1.0",
	runs: [
		{
			tool: {
				driver: {
					name: "GitHub Actions lint",
					version: "1.7.12",
					informationUri: "https://github.com/rhysd/actionlint",
					rules: [
						{
							id: "expression",
							name: "Expression",
							defaultConfiguration: { level: "error" },
						},
					],
				},
			},
			results: [
				{
					ruleId: "expression",
					message: { text: "got unexpected character" },
					locations: [
						{
							physicalLocation: {
								artifactLocation: {
									uri: ".github/workflows/ci.yml",
									uriBaseId: "%SRCROOT%",
								},
								region: {
									startLine: 5,
									startColumn: 9,
									endColumn: 9,
									snippet: { text: expressionSnippet },
								},
							},
						},
					],
				},
			],
		},
	],
});

// Minimal well-formed SARIF with no results
const SARIF_NO_RESULTS = JSON.stringify({
	$schema:
		"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	version: "2.1.0",
	runs: [
		{
			tool: {
				driver: {
					name: "GitHub Actions lint",
					version: "1.7.12",
					informationUri: "https://github.com/rhysd/actionlint",
					rules: [],
				},
			},
			results: [],
		},
	],
});

function createActionlintStub(context) {
	writeExecutable(
		path.join(context.binDir, "actionlint"),
		`#!/usr/bin/env bash
set -euo pipefail
case "\${ACTIONLINT_STUB_MODE:-success}" in
  success)
    printf '%s\\n' '${SARIF_WITH_RESULTS.replace(/'/g, "'\\''")}'
    exit 1
    ;;
  success_with_stderr)
    printf '%s\\n' '${SARIF_WITH_RESULTS.replace(/'/g, "'\\''")}'
    printf 'actionlint emitted SARIF with a warning on stderr\\n' >&2
    exit 1
    ;;
  no_results)
    printf '%s\\n' '${SARIF_NO_RESULTS.replace(/'/g, "'\\''")}'
    exit 0
    ;;
  empty)
    printf 'actionlint failed to produce output\\n' >&2
    exit 3
    ;;
  malformed)
    printf '{not valid json\\n'
    printf 'actionlint produced malformed SARIF\\n' >&2
    exit 1
    ;;
esac
`,
	);
}

function createRunScriptWithoutTemplate(context) {
	const tempRoot = path.join(context.tempDir, "actionlint-script-root");
	const tempActionlintDir = path.join(tempRoot, "actionlint");
	const tempGithubScriptsDir = path.join(tempRoot, ".github", "scripts");
	const tempRunPath = path.join(tempActionlintDir, "run.sh");
	const tempCommonPath = path.join(tempActionlintDir, "common.sh");
	const tempLibraryPath = path.join(tempGithubScriptsDir, "linter-library.sh");

	fs.mkdirSync(tempActionlintDir, { recursive: true });
	fs.mkdirSync(tempGithubScriptsDir, { recursive: true });
	fs.copyFileSync(runPath, tempRunPath);
	fs.copyFileSync(commonPath, tempCommonPath);
	fs.copyFileSync(linterLibraryPath, tempLibraryPath);
	fs.chmodSync(tempRunPath, 0o755);

	return tempRunPath;
}

test("actionlint/run.sh emits SARIF result with findings", () => {
	const context = makeTempRepo("actionlint-run-sarif-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const output = execFileSync(
			bashPath,
			[runPath, ".github/workflows/ci.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createNodeOnlyEnv(context),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.ok(result.sarif, "result should have sarif key");
		assert.equal(result.sarif.runs[0].results[0].ruleId, "expression");
		assert.equal(
			result.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			".github/workflows/ci.yml",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("actionlint/run.sh sets exit_code=0 when no findings", () => {
	const context = makeTempRepo("actionlint-run-no-findings-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const output = execFileSync(
			bashPath,
			[runPath, ".github/workflows/ci.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createNodeOnlyEnv(context, {
					ACTIONLINT_STUB_MODE: "no_results",
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.ok(result.sarif, "result should have sarif key");
		assert.equal(result.sarif.runs[0].results.length, 0);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("actionlint/run.sh fails when native SARIF output is missing", () => {
	const context = makeTempRepo("actionlint-run-missing-sarif-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, { ACTIONLINT_STUB_MODE: "empty" }),
		});

		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/actionlint native SARIF output was empty or missing/u,
		);
		assert.equal(result.stdout, "");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("actionlint/run.sh forwards stderr when SARIF output is available", () => {
	const context = makeTempRepo("actionlint-run-stderr-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, {
				ACTIONLINT_STUB_MODE: "success_with_stderr",
			}),
		});

		assert.equal(result.status, 0);
		assert.match(
			result.stderr,
			/actionlint emitted SARIF with a warning on stderr/u,
		);
		assert.equal(JSON.parse(result.stdout).exit_code, 1);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("actionlint/run.sh fails fast when SARIF template is missing", () => {
	const context = makeTempRepo("actionlint-run-missing-template-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const isolatedRunPath = createRunScriptWithoutTemplate(context);
		const result = spawnSync(
			bashPath,
			[isolatedRunPath, ".github/workflows/ci.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createNodeOnlyEnv(context),
			},
		);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /sarif_template\.txt/u);
		assert.equal(result.stdout, "");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("actionlint/run.sh surfaces tool stderr before failing malformed SARIF", () => {
	const context = makeTempRepo("actionlint-run-malformed-sarif-");

	createActionlintStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, { ACTIONLINT_STUB_MODE: "malformed" }),
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /actionlint produced malformed SARIF/u);
		assert.match(result.stderr, /SyntaxError/u);
		assert.equal(result.stdout, "");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
