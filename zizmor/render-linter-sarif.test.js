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

// Native SARIF as emitted by `zizmor --format=sarif`
const nativeSarif = {
	$schema:
		"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
	version: "2.1.0",
	runs: [
		{
			tool: {
				driver: {
					name: "zizmor",
					version: "1.24.1",
					informationUri: "https://docs.zizmor.sh",
					rules: [
						{
							id: "zizmor/unpinned-uses",
							name: "unpinned-uses",
							helpUri: "https://docs.zizmor.sh/audits/#unpinned-uses",
							help: {
								text: "unpinned action reference",
								markdown:
									"`unpinned-uses`: unpinned action reference\n\nDocs: <https://docs.zizmor.sh/audits/#unpinned-uses>",
							},
						},
					],
				},
			},
			results: [
				{
					ruleId: "zizmor/unpinned-uses",
					level: "error",
					message: { text: "unpinned action reference" },
					locations: [
						{
							physicalLocation: {
								artifactLocation: {
									uri: ".github/workflows/ci.yml",
								},
								region: {
									startLine: 14,
									startColumn: 5,
									endLine: 14,
									endColumn: 30,
								},
							},
						},
					],
				},
			],
		},
	],
};

test("prefers embedded zizmor SARIF when available", () => {
	const context = makeTempRepo("render-linter-sarif-zizmor-");

	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		".github/workflows/ci.yml\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			exit_code: 1,
			sarif: nativeSarif,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "zizmor",
			OUTPUT_PATH: path.join(context.runnerTemp, "zizmor.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(
			report.sarif.runs[0].results[0].ruleId,
			"zizmor/unpinned-uses",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			".github/workflows/ci.yml",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			14,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			5,
		);
		// Rules are sourced from native SARIF
		assert.equal(
			report.sarif.runs[0].tool.driver.rules[0].id,
			"zizmor/unpinned-uses",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
