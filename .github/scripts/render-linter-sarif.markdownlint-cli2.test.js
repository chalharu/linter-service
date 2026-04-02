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
const details =
	"README.md:7: MD013/line-length Line length [Expected: 80; Actual: 120]";

test("emits SARIF for markdownlint-cli2 diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-markdownlint-cli2-");

	writeFile(path.join(context.repoDir, "README.md"), "# title\n");
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
			LINTER_NAME: "markdownlint-cli2",
			OUTPUT_PATH: path.join(context.runnerTemp, "markdownlint-cli2.sarif"),
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
			7,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
