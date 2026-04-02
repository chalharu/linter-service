const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./linters/cargo-linter-test-lib.js");
const { renderSarif, runFromEnv } = require("./render-linter-sarif.js");

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
						details_fallback: "fallback",
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
						details_fallback: "fallback",
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
						details_fallback: "fallback",
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
						details_fallback: "fallback",
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
