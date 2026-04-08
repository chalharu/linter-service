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
const details =
	"lint ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  × Some errors were emitted while running checks.";
const nativeSarif = {
	$schema: "https://json.schemastore.org/sarif-2.1.0.json",
	runs: [
		{
			results: [
				{
					level: "error",
					locations: [
						{
							physicalLocation: {
								artifactLocation: {
									uri: "/tmp/placeholder/repo/src/app.ts",
								},
								region: {
									endColumn: 10,
									endLine: 4,
									startColumn: 3,
									startLine: 4,
								},
							},
						},
					],
					message: {
						text: "debug statements are not allowed",
					},
					ruleId: "lint/suspicious/noDebugger",
				},
			],
			tool: {
				driver: {
					rules: [
						{
							helpUri: "https://biomejs.dev/linter/rules/no-debugger/",
							id: "lint/suspicious/noDebugger",
							shortDescription: {
								text: "Disallow debugger statements.",
							},
						},
					],
				},
			},
		},
	],
	version: "2.1.0",
};

test("prefers native Biome SARIF when available", () => {
	const context = makeTempRepo("render-linter-sarif-biome-");

	try {
		const nativeSarifReport = structuredClone(nativeSarif);
		nativeSarifReport.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri =
			path.join(context.repoDir, "src/app.ts");

		writeFile(path.join(context.repoDir, "src/app.ts"), 'console.log("x")\n');
		writeFile(
			path.join(context.runnerTemp, "selected-files.txt"),
			"src/app.ts\n",
		);
		writeFile(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({
				details,
				exit_code: 1,
			}),
		);
		writeFile(
			path.join(context.runnerTemp, "biome-native.sarif"),
			JSON.stringify(nativeSarifReport),
		);

		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "biome",
			OUTPUT_PATH: path.join(context.runnerTemp, "biome.sarif"),
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
			"lint/suspicious/noDebugger",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/app.ts",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			4,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			3,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.endColumn,
			10,
		);
		assert.equal(
			report.sarif.runs[0].tool.driver.rules[0].helpUri,
			"https://biomejs.dev/linter/rules/no-debugger/",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
