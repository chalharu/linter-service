const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	applyWorkflowEnvironment,
	normalizeFixtureResult,
	normalizeSarif,
	parseArgs,
	runFixtureTests,
} = require("./run-fixture-tests.js");

function makeTempRepo() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-fixture-tests-"));
	const repoDir = path.join(tempDir, "repo");
	fs.mkdirSync(path.join(repoDir, ".github", "scripts"), { recursive: true });
	return { repoDir, tempDir };
}

function cleanupTempRepo(tempDir) {
	fs.rmSync(tempDir, { force: true, recursive: true });
}

function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function writeExecutable(filePath, content) {
	writeFile(filePath, content);
	fs.chmodSync(filePath, 0o755);
}

function scaffoldFakeLinterRepo(repoDir) {
	writeFile(
		path.join(repoDir, "linters.json"),
		JSON.stringify(
			{
				linters: [
					{
						name: "fake-linter",
						heading: "### fake-linter",
						no_files: "No files selected.",
						success: "✅ No issues.",
						failure: "❌ Issues found.",
						infra_failure: "❌ Infra failure.",
						details_fallback: "No output.",
						sarif: {
							enabled: true,
						},
					},
				],
			},
			null,
			2,
		),
	);
	fs.copyFileSync(
		path.join(__dirname, "linter-library.sh"),
		path.join(repoDir, ".github", "scripts", "linter-library.sh"),
	);
	writeExecutable(
		path.join(repoDir, "fake-linter", "common.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../.github/scripts/linter-library.sh
source "$script_dir/../.github/scripts/linter-library.sh"
`,
	);
	writeExecutable(
		path.join(repoDir, "fake-linter", "patterns.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
\\.txt$
EOF
`,
	);
	writeExecutable(
		path.join(repoDir, "fake-linter", "install.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
: "\${RUNNER_TEMP:?RUNNER_TEMP is required}"
mkdir -p "$RUNNER_TEMP/fake-bin"
cat > "$RUNNER_TEMP/fake-bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
exit_code="$2"
output_file="$3"
node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");
const [exitCode, outputFile] = process.argv.slice(2);
const details = fs.existsSync(outputFile)
  ? fs.readFileSync(outputFile, "utf8").trim()
  : "";
process.stdout.write(JSON.stringify({ details, exit_code: Number(exitCode) }));
NODE
EOF
cat > "$RUNNER_TEMP/fake-bin/fake-tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
status=0
for file in "$@"; do
  if grep -q 'FAIL' "$file"; then
    printf '%s:1:1: fake failure\\n' "$file"
    status=1
  fi
done
exit "$status"
EOF
chmod +x "$RUNNER_TEMP/fake-bin/python3" "$RUNNER_TEMP/fake-bin/fake-tool"
printf '%s\\n' "$RUNNER_TEMP/fake-bin" >> "$GITHUB_PATH"
printf 'FAKE_MODE=ready\\n' >> "$GITHUB_ENV"
`,
	);
	writeExecutable(
		path.join(repoDir, "fake-linter", "run.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"
: "\${RUNNER_TEMP:?RUNNER_TEMP is required}"
test "\${FAKE_MODE:-}" = "ready"
output_file="$RUNNER_TEMP/linter-output.txt"
linter_lib::run_and_emit_json "$output_file" fake-tool "$@"
`,
	);

	writeFile(
		path.join(repoDir, "fake-linter", "tests", "pass", "target", "pass.txt"),
		"PASS\n",
	);
	writeFile(
		path.join(repoDir, "fake-linter", "tests", "fail", "target", "fail.txt"),
		"FAIL\n",
	);
}

test("parseArgs recognizes --write and positional linter names", () => {
	assert.deepEqual(parseArgs(["--write", "actionlint", "yamllint"]), {
		linterNames: ["actionlint", "yamllint"],
		write: true,
	});
});

test("applyWorkflowEnvironment persists GITHUB_PATH and GITHUB_ENV entries", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-env-"));
	const githubPathPath = path.join(tempDir, "github-path.txt");
	const githubEnvPath = path.join(tempDir, "github-env.txt");

	fs.writeFileSync(githubPathPath, "/tmp/tool/bin\n", "utf8");
	fs.writeFileSync(githubEnvPath, "TOOL_READY=yes\n", "utf8");

	try {
		const nextEnv = applyWorkflowEnvironment(
			{
				GITHUB_ENV: githubEnvPath,
				GITHUB_PATH: githubPathPath,
				PATH: "/usr/bin",
			},
			{
				githubEnvPath,
				githubPathPath,
			},
		);

		assert.equal(nextEnv.TOOL_READY, "yes");
		assert.match(nextEnv.PATH, /^\/tmp\/tool\/bin/u);
		assert.equal("GITHUB_ENV" in nextEnv, false);
		assert.equal("GITHUB_PATH" in nextEnv, false);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("normalizeFixtureResult removes temp paths and volatile durations", () => {
	const repositoryPath = "/tmp/fixture-run/repo";
	const actual = normalizeFixtureResult({
		report: {
			checkedProjects: ["/tmp/fixture-run/repo/crate-b", "crate-a"],
			selectedFiles: ["/tmp/fixture-run/repo/src/index.js", "README.md"],
		},
		repositoryPath,
		result: {
			details:
				'cwd="/tmp/fixture-run/repo"\n/tmp/fixture-run/repo/src/index.js:1:1 error bad\nApr  3 09:04:51.246 ERR something happened\n2025-04-03T09:04:51.246Z info done\nChecked 1 file in 4ms. No fixes applied.\nFinished dev profile in 0.45s',
			exit_code: 1,
		},
	});

	assert.deepEqual(actual, {
		checked_projects: ["crate-a", "crate-b"],
		result: {
			details:
				'cwd="."\nsrc/index.js:1:1 error bad\n<timestamp> ERR something happened\n<timestamp> info done\nChecked 1 file in <duration>. No fixes applied.\nFinished dev profile in <duration>',
			exit_code: 1,
		},
		selected_files: ["README.md", "src/index.js"],
	});
});

test("normalizeSarif removes volatile timestamps and partial fingerprints", () => {
	const actual = normalizeSarif(
		{
			$schema: "https://json.schemastore.org/sarif-2.1.0.json",
			runs: [
				{
					results: [
						{
							level: "error",
							locations: [
								{
									physicalLocation: {
										artifactLocation: {
											uri: "/tmp/fixture-run/repo/src/index.js",
										},
									},
								},
							],
							message: {
								text: "Apr  3 09:07:33.011 ERR /tmp/fixture-run/repo/src/index.js failed in 4ms",
							},
							partialFingerprints: {
								primaryLocationLineHash: "abc123",
							},
							ruleId: "demo/error",
						},
					],
					tool: {
						driver: {
							rules: [{ id: "demo/error", name: "demo/error" }],
						},
					},
				},
			],
			version: "2.1.0",
		},
		"/tmp/fixture-run/repo",
	);

	assert.deepEqual(actual, {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		runs: [
			{
				results: [
					{
						level: "error",
						locations: [
							{
								physicalLocation: {
									artifactLocation: {
										uri: "src/index.js",
									},
								},
							},
						],
						message: {
							text: "<timestamp> ERR src/index.js failed in <duration>",
						},
						ruleId: "demo/error",
					},
				],
				tool: {
					driver: {
						rules: [{ id: "demo/error", name: "demo/error" }],
					},
				},
			},
		],
		version: "2.1.0",
	});
});

test("runFixtureTests can write and then verify fake linter fixtures", () => {
	const context = makeTempRepo();
	scaffoldFakeLinterRepo(context.repoDir);

	try {
		const writeReport = runFixtureTests({
			linterNames: ["fake-linter"],
			repositoryPath: context.repoDir,
			write: true,
		});
		const verifyReport = runFixtureTests({
			linterNames: ["fake-linter"],
			repositoryPath: context.repoDir,
			write: false,
		});

		assert.equal(writeReport.linters[0].fixtures.length, 2);
		assert.equal(verifyReport.linters[0].fixtures.length, 2);
		assert.equal(
			fs.existsSync(
				path.join(
					context.repoDir,
					"fake-linter",
					"tests",
					"pass",
					"result.json",
				),
			),
			true,
		);
		assert.equal(
			fs.existsSync(
				path.join(
					context.repoDir,
					"fake-linter",
					"tests",
					"fail",
					"sarif.json",
				),
			),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("runFixtureTests requires at least two fixture directories per linter", () => {
	const context = makeTempRepo();
	scaffoldFakeLinterRepo(context.repoDir);
	fs.rmSync(path.join(context.repoDir, "fake-linter", "tests", "fail"), {
		force: true,
		recursive: true,
	});

	try {
		assert.throws(
			() =>
				runFixtureTests({
					linterNames: ["fake-linter"],
					repositoryPath: context.repoDir,
					write: true,
				}),
			/at least 2 fixture tests/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
