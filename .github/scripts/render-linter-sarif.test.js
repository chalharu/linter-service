const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./cargo-linter-test-lib.js");
const {
	normalizeReportedPath,
	renderSarif,
	runFromEnv,
} = require("./render-linter-sarif.js");
const rootConfigPath = path.join(__dirname, "..", "..", "linters.json");

test("does not emit SARIF when the linter has no SARIF config", () => {
	const context = makeTempRepo("render-linter-sarif-disabled-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {},
				},
			},
			null,
			2,
		),
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({ details: "", exit_code: 0 }),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("emits empty SARIF when an enabled linter succeeds", () => {
	const context = makeTempRepo("render-linter-sarif-success-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('ok');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({ details: "", exit_code: 0 }),
	);

	try {
		const report = runFromEnv({
			EXIT_CODE: "0",
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "example",
			OUTPUT_PATH: path.join(context.runnerTemp, "example.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		const sarif = JSON.parse(
			fs.readFileSync(path.join(context.runnerTemp, "example.sarif"), "utf8"),
		);
		assert.equal(sarif.version, "2.1.0");
		assert.deepEqual(sarif.runs[0].results, []);
		assert.equal(sarif.runs[0].automationDetails.id, "linter-service/example");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("emits SARIF when a successful run reports non-blocking warnings", () => {
	const context = makeTempRepo("render-linter-sarif-warning-success-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('ok');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "warning[EX123]: unexpected thing",
			exit_code: 0,
			warning_count: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].level, "warning");
		assert.equal(report.sarif.runs[0].results[0].ruleId, "EX123");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/app.js",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("does not emit SARIF when the linter run failed before producing a result", () => {
	const context = makeTempRepo("render-linter-sarif-run-failed-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('ok');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "missing-result.json"),
			runOutcome: "failure",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("parses file line and column diagnostics into SARIF results", () => {
	const context = makeTempRepo("render-linter-sarif-diagnostics-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('bad');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "src/app.js:12:3: EX123 unexpected thing",
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].ruleId, "EX123");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/app.js",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			12,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			3,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("prefers embedded SARIF results and rules over legacy details", () => {
	const context = makeTempRepo("render-linter-sarif-embedded-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('bad');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "src/app.js:1:1: EX999 legacy fallback",
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [
							{
								level: "error",
								locations: [
									{
										physicalLocation: {
											artifactLocation: {
												uri: path.join(context.repoDir, "src/app.js"),
											},
											region: {
												startColumn: 3,
												startLine: 4,
											},
										},
									},
								],
								message: {
									text: "native failure",
								},
								ruleId: "EX123",
							},
						],
						tool: {
							driver: {
								rules: [
									{
										helpUri: "https://example.invalid/rules/EX123",
										id: "EX123",
										shortDescription: {
											text: "native rule",
										},
									},
								],
							},
						},
					},
				],
				version: "2.1.0",
			},
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].ruleId, "EX123");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/app.js",
		);
		assert.equal(
			report.sarif.runs[0].tool.driver.rules[0].helpUri,
			"https://example.invalid/rules/EX123",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("falls back to derived rules when embedded SARIF has no results", () => {
	const context = makeTempRepo("render-linter-sarif-embedded-empty-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('bad');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "src/app.js:1:1: EX999 legacy fallback",
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [],
						tool: {
							driver: {
								rules: [
									{
										helpUri: "https://example.invalid/rules/EX123",
										id: "EX123",
										shortDescription: {
											text: "unused embedded rule",
										},
									},
								],
							},
						},
					},
				],
				version: "2.1.0",
			},
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].ruleId, "EX999");
		assert.equal(report.sarif.runs[0].tool.driver.rules.length, 1);
		assert.equal(report.sarif.runs[0].tool.driver.rules[0].id, "EX999");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps failing-file counts unknown when fallback diagnostics have no file path", () => {
	const context = makeTempRepo("render-linter-sarif-pathless-fallback-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('bad');\n");
	writeFile(
		path.join(context.repoDir, "src/worker.js"),
		"console.log('ok');\n",
	);
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.js\nsrc/worker.js\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "configuration file is invalid",
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.targetStats.counts_known, false);
		assert.equal(report.targetStats.issue_count, 1);
		assert.equal(report.targetStats.issue_target_count, null);
		assert.equal(report.targetStats.passed_target_count, null);
		assert.equal(report.targetStats.target_count, 2);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].locations, undefined);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("does not remap temp-worktree absolute paths for generated files missing from the repository", () => {
	const context = makeTempRepo("render-linter-sarif-temp-worktree-path-");

	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn demo() {}\n");

	try {
		const resolved = normalizeReportedPath(
			context.repoDir,
			path.join(
				context.runnerTemp,
				"cargo-clippy-workspace/source/target/debug/build/demo/out/generated.rs",
			),
			["src/lib.rs"],
			[path.join(context.runnerTemp, "cargo-clippy-workspace/source")],
		);

		assert.equal(resolved, null);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps substring matches from changing the default SARIF severity", () => {
	const context = makeTempRepo("render-linter-sarif-severity-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.py"), "print('bad')\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: {
					example: {
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
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/app.py\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details:
				"src/app.py:8:3: F841 Local variable 'error_count' is assigned to but never used\nsrc/app.py:9:3: APP_INFO is not in alphabetical order",
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath,
			installOutcome: "success",
			linterName: "example",
			outputPath: path.join(context.runnerTemp, "example.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.deepEqual(
			report.sarif.runs[0].results.map((result) => result.level),
			["warning", "warning"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("counts rustfmt issue targets from colon-form diff lines instead of echoed checked paths", () => {
	const context = makeTempRepo("render-linter-sarif-rustfmt-fallback-");
	const selectedFiles = [
		"src/lib.rs",
		"src/main.rs",
		"crates/member/src/lib.rs",
		"crates/member/src/main.rs",
		"examples/demo.rs",
		"tests/basic.rs",
		"tests/advanced.rs",
		"benches/bench.rs",
		"tools/helper.rs",
	];
	const details = `${selectedFiles
		.map((filePath) => `==> rustfmt --check ${filePath}`)
		.join("\n")}\nDiff in src/lib.rs:1:\n`;

	for (const filePath of selectedFiles) {
		writeFile(path.join(context.repoDir, filePath), "fn demo() {}\n");
	}
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		`${selectedFiles.join("\n")}\n`,
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details,
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath: rootConfigPath,
			installOutcome: "success",
			linterName: "rustfmt",
			outputPath: path.join(context.runnerTemp, "rustfmt.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.targetStats.issue_target_count, 1);
		assert.equal(report.targetStats.passed_target_count, 8);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("counts rustfmt issue targets from at-line diff lines instead of echoed checked paths", () => {
	const context = makeTempRepo("render-linter-sarif-rustfmt-at-line-");
	const selectedFiles = ["src/lib.rs", "src/main.rs"];
	const details = `${selectedFiles
		.map((filePath) => `==> rustfmt --check ${filePath}`)
		.join("\n")}\nDiff in src/lib.rs at line 1:\n`;

	for (const filePath of selectedFiles) {
		writeFile(path.join(context.repoDir, filePath), "fn demo() {}\n");
	}
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		`${selectedFiles.join("\n")}\n`,
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details,
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath: rootConfigPath,
			installOutcome: "success",
			linterName: "rustfmt",
			outputPath: path.join(context.runnerTemp, "rustfmt.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.targetStats.issue_target_count, 1);
		assert.equal(report.targetStats.passed_target_count, 1);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("counts rustfmt issue targets from absolute diff lines instead of echoed checked paths", () => {
	const context = makeTempRepo("render-linter-sarif-rustfmt-absolute-");
	const selectedFiles = ["src/lib.rs", "src/main.rs"];

	for (const filePath of selectedFiles) {
		writeFile(path.join(context.repoDir, filePath), "fn demo() {}\n");
	}

	const details = `${selectedFiles
		.map((filePath) => `==> rustfmt --check ${filePath}`)
		.join("\n")}\nDiff in ${path.join(context.repoDir, "src/lib.rs")}:1:\n`;

	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		`${selectedFiles.join("\n")}\n`,
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details,
			exit_code: 1,
		}),
	);

	try {
		const report = renderSarif({
			configPath: rootConfigPath,
			installOutcome: "success",
			linterName: "rustfmt",
			outputPath: path.join(context.runnerTemp, "rustfmt.sarif"),
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
		});

		assert.equal(report.targetStats.issue_target_count, 1);
		assert.equal(report.targetStats.passed_target_count, 1);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
