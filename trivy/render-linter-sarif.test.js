const path = require("node:path");
const test = require("node:test");

const {
	assert,
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");
const { runFromEnv } = require("../.github/scripts/render-linter-sarif.js");

const configPath = path.join(__dirname, "..", "linters.json");
const details = [
	"Dockerfile:1:1: warning DS-0001 (MEDIUM): Specify a tag in the 'FROM' statement for image 'ubuntu'",
	"Dockerfile:2:1: error DS-0002 (HIGH): Last USER command in Dockerfile should not be 'root'",
].join("\n");

test("emits SARIF for Trivy diagnostics rendered as path diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-trivy-");

	writeFile(
		path.join(context.repoDir, "Dockerfile"),
		"FROM ubuntu:latest\nUSER root\n",
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
			LINTER_NAME: "trivy",
			OUTPUT_PATH: path.join(context.runnerTemp, "trivy.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.deepEqual(
			report.sarif.runs[0].results.map((result) => ({
				level: result.level,
				line: result.locations[0].physicalLocation.region.startLine,
				ruleId: result.ruleId,
			})),
			[
				{
					level: "warning",
					line: 1,
					ruleId: "DS-0001",
				},
				{
					level: "error",
					line: 2,
					ruleId: "DS-0002",
				},
			],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
