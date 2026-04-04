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

test("does not emit SARIF when the linter has no SARIF config", () => {
	const context = makeTempRepo("render-linter-sarif-disabled-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: [
					{
						name: "example",
					},
				],
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
				linters: [
					{
						name: "example",
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

test("does not emit SARIF when the linter run failed before producing a result", () => {
	const context = makeTempRepo("render-linter-sarif-run-failed-");
	const configPath = path.join(context.tempDir, "config.json");

	writeFile(path.join(context.repoDir, "src/app.js"), "console.log('ok');\n");
	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: [
					{
						name: "example",
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
				linters: [
					{
						name: "example",
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
				linters: [
					{
						name: "example",
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
