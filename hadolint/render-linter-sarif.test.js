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
const details = "Dockerfile:2 DL3008 Pin versions in apt get install.";

test("emits SARIF for hadolint diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-hadolint-");

	writeFile(
		path.join(context.repoDir, "Dockerfile"),
		"FROM ubuntu:latest\nRUN apt-get install curl\n",
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"Dockerfile\n",
	);
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
			LINTER_NAME: "hadolint",
			OUTPUT_PATH: path.join(context.runnerTemp, "hadolint.sarif"),
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
			"Dockerfile",
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
