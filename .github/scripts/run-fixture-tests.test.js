const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	applyWorkflowEnvironment,
	normalizeFixtureAssertionValue,
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
				linters: {
					"fake-linter": {
						sarif: {
							enabled: true,
						},
					},
				},
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
printf 'markdownlint-cli2 v1.2.3\\n'
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

test("applyWorkflowEnvironment builds PATH when the base env has no PATH", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-env-"));
	const githubPathPath = path.join(tempDir, "github-path.txt");
	const githubEnvPath = path.join(tempDir, "github-env.txt");

	fs.writeFileSync(githubPathPath, "/tmp/tool/bin\n", "utf8");
	fs.writeFileSync(githubEnvPath, "", "utf8");

	try {
		const nextEnv = applyWorkflowEnvironment(
			{
				GITHUB_ENV: githubEnvPath,
				GITHUB_PATH: githubPathPath,
			},
			{
				githubEnvPath,
				githubPathPath,
			},
		);

		assert.equal(nextEnv.PATH, "/tmp/tool/bin");
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

test("normalizeFixtureResult removes linter tool versions", () => {
	const actual = normalizeFixtureResult({
		report: {
			checkedProjects: [],
			selectedFiles: ["README.md"],
		},
		repositoryPath: "/tmp/fixture-run/repo",
		result: {
			details:
				"markdownlint-cli2 v0.22.1 (markdownlint v0.40.0)\n" +
				"program=ghalint version=1.5.5\n" +
				"https://rust-lang.github.io/rust-clippy/rust-1.95.0/index.html#ptr_arg\n" +
				"unrelated rust-1.95.0 text stays intact",
			exit_code: 1,
		},
	});

	assert.deepEqual(actual, {
		checked_projects: [],
		result: {
			details:
				"markdownlint-cli2 v<version> (markdownlint v<version>)\n" +
				"program=ghalint version=<version>\n" +
				"https://rust-lang.github.io/rust-clippy/rust-<version>/index.html#ptr_arg\n" +
				"unrelated rust-1.95.0 text stays intact",
			exit_code: 1,
		},
		selected_files: ["README.md"],
	});
});

test("normalizeFixtureResult stabilizes cargo-clippy compile error ordering", () => {
	const actual = normalizeFixtureResult({
		report: {
			checkedProjects: ["Cargo.toml"],
			selectedFiles: ["src/lib.rs"],
		},
		repositoryPath: "/tmp/fixture-run/repo",
		result: {
			details:
				"error: could not compile `fixture-fail` (lib test) due to 1 previous error\nwarning: build failed, waiting for other jobs to finish...\nerror: could not compile `fixture-fail` (lib) due to 1 previous error",
			exit_code: 1,
		},
	});

	assert.deepEqual(actual, {
		checked_projects: ["Cargo.toml"],
		result: {
			details:
				"error: could not compile `fixture-fail` (lib) due to 1 previous error\nwarning: build failed, waiting for other jobs to finish...\nerror: could not compile `fixture-fail` (lib test) due to 1 previous error",
			exit_code: 1,
		},
		selected_files: ["src/lib.rs"],
	});
});

test("normalizeFixtureResult canonicalizes embedded SARIF results", () => {
	const actual = normalizeFixtureResult({
		report: {
			checkedProjects: [],
			selectedFiles: ["src/index.js"],
		},
		repositoryPath: "/tmp/fixture-run/repo",
		result: {
			exit_code: 1,
			sarif: {
				$schema: "https://json.schemastore.org/sarif-2.1.0.json",
				runs: [
					{
						results: [
							{
								level: "warning",
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
									text: "second",
								},
								partialFingerprints: {
									primaryLocationLineHash: "def",
								},
								ruleId: "b",
							},
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
									text: "first",
								},
								partialFingerprints: {
									primaryLocationLineHash: "abc",
								},
								ruleId: "a",
							},
						],
						tool: {
							driver: {
								rules: [
									{ id: "b", name: "b" },
									{ id: "a", name: "a" },
								],
								semanticVersion: "1.2.3",
								version: "1.2.3",
							},
							extensions: [
								{
									name: "demo-extension",
									properties: {
										config: {
											version: "preserved",
										},
									},
									version: "1.2.3",
								},
							],
						},
					},
				],
				version: "2.1.0",
			},
		},
	});

	assert.deepEqual(actual, {
		checked_projects: [],
		result: {
			exit_code: 1,
			sarif: {
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
									text: "first",
								},
								ruleId: "a",
							},
							{
								level: "warning",
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
									text: "second",
								},
								ruleId: "b",
							},
						],
						tool: {
							driver: {
								rules: [
									{ id: "a", name: "a" },
									{ id: "b", name: "b" },
								],
							},
							extensions: [
								{
									name: "demo-extension",
									properties: {
										config: {
											version: "preserved",
										},
									},
								},
							],
						},
					},
				],
				version: "2.1.0",
			},
		},
		selected_files: ["src/index.js"],
	});
});

test("normalizeFixtureAssertionValue removes embedded SARIF tool versions", () => {
	const actual = normalizeFixtureAssertionValue({
		checked_projects: [],
		result: {
			exit_code: 1,
			sarif: {
				runs: [
					{
						tool: {
							driver: {
								name: "demo",
								version: "1.2.3",
							},
							extensions: [
								{
									name: "demo-extension",
									properties: {
										config: {
											version: "preserved",
										},
									},
									version: "1.2.3",
								},
							],
						},
					},
				],
				version: "2.1.0",
			},
		},
		selected_files: ["src/index.js"],
	});

	assert.deepEqual(actual, {
		checked_projects: [],
		result: {
			exit_code: 1,
			sarif: {
				runs: [
					{
						tool: {
							driver: {
								name: "demo",
							},
							extensions: [
								{
									name: "demo-extension",
									properties: {
										config: {
											version: "preserved",
										},
									},
								},
							],
						},
					},
				],
				version: "2.1.0",
			},
		},
		selected_files: ["src/index.js"],
	});
});

test("normalizeFixtureResult preserves non-SARIF tool version fields", () => {
	const actual = normalizeFixtureResult({
		report: {
			checkedProjects: [],
			selectedFiles: ["README.md"],
		},
		repositoryPath: "/tmp/fixture-run/repo",
		result: {
			tool: {
				driver: {
					name: "not-sarif",
					version: "1.2.3",
				},
			},
			audit: {
				runs: [
					{
						tool: {
							driver: {
								name: "not-sarif",
								version: "1.2.3",
							},
							extensions: [
								{
									name: "not-sarif-extension",
									version: "1.2.3",
								},
							],
						},
					},
				],
			},
		},
	});

	assert.deepEqual(actual, {
		checked_projects: [],
		result: {
			tool: {
				driver: {
					name: "not-sarif",
					version: "1.2.3",
				},
			},
			audit: {
				runs: [
					{
						tool: {
							driver: {
								name: "not-sarif",
								version: "1.2.3",
							},
							extensions: [
								{
									name: "not-sarif-extension",
									version: "1.2.3",
								},
							],
						},
					},
				],
			},
		},
		selected_files: ["README.md"],
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
							version: "1.2.3",
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

test("runFixtureTests compares version-normalized fixture outputs", () => {
	const context = makeTempRepo();
	scaffoldFakeLinterRepo(context.repoDir);

	try {
		runFixtureTests({
			linterNames: ["fake-linter"],
			repositoryPath: context.repoDir,
			write: true,
		});

		const passResultPath = path.join(
			context.repoDir,
			"fake-linter",
			"tests",
			"pass",
			"result.json",
		);
		const recorded = fs.readFileSync(passResultPath, "utf8");
		assert.match(recorded, /markdownlint-cli2 v<version>/u);
		fs.writeFileSync(
			passResultPath,
			recorded.replace(
				"markdownlint-cli2 v<version>",
				"markdownlint-cli2 v9.9.9",
			),
			"utf8",
		);

		const verifyReport = runFixtureTests({
			linterNames: ["fake-linter"],
			repositoryPath: context.repoDir,
			write: false,
		});

		assert.equal(verifyReport.linters[0].fixtures.length, 2);
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
