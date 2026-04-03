const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");
const { runFromEnv } = require("../.github/scripts/render-linter-sarif.js");

const configPath = path.join(__dirname, "..", "linters.json");
const details = "README.md:2: wrong line endings";

test("emits SARIF for editorconfig-checker diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-editorconfig-checker-");

	writeFile(path.join(context.repoDir, "README.md"), "# title\r\n");
	writeFile(path.join(context.runnerTemp, "selected-files.txt"), "README.md\n");
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details,
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "editorconfig-checker",
			OUTPUT_PATH: path.join(context.runnerTemp, "editorconfig-checker.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.ok(report.sarif.runs[0].results.length >= 1);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"README.md",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			2,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
