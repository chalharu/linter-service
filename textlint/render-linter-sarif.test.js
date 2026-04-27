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

test("emits SARIF for embedded textlint diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-textlint-");

	writeFile(path.join(context.repoDir, "README.md"), "これはテストです！\n");
	writeFile(path.join(context.runnerTemp, "selected-files.txt"), "README.md\n");
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			exit_code: 1,
			sarif: {
				version: "2.1.0",
				runs: [
					{
						results: [
							{
								level: "error",
								locations: [
									{
										physicalLocation: {
											artifactLocation: {
												uri: "README.md",
											},
											region: {
												startColumn: 9,
												startLine: 1,
											},
										},
									},
								],
								message: {
									text: 'Disallow to use "！".',
								},
								ruleId: "ja-technical-writing/no-exclamation-question-mark",
							},
						],
						tool: {
							driver: {
								rules: [
									{
										id: "ja-technical-writing/no-exclamation-question-mark",
										name: "ja-technical-writing/no-exclamation-question-mark",
										shortDescription: {
											text: "ja-technical-writing/no-exclamation-question-mark",
										},
									},
								],
							},
						},
					},
				],
			},
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "textlint",
			OUTPUT_PATH: path.join(context.runnerTemp, "textlint.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(
			report.sarif.runs[0].results[0].ruleId,
			"ja-technical-writing/no-exclamation-question-mark",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"README.md",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
