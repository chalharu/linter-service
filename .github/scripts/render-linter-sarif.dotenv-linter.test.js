const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./linters/cargo-linter-test-lib.js");
const { runFromEnv } = require("./render-linter-sarif.js");

const configPath = path.join(__dirname, "linters/config.json");
const details = ".env:1: duplicated name FOO";

test("emits SARIF for dotenv-linter diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-dotenv-linter-");

	writeFile(path.join(context.repoDir, ".env"), "FOO=bar\n");
	writeFile(path.join(context.runnerTemp, "selected-files.txt"), ".env\n");
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
			LINTER_NAME: "dotenv-linter",
			OUTPUT_PATH: path.join(context.runnerTemp, "dotenv-linter.sarif"),
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
			".env",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			1,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
