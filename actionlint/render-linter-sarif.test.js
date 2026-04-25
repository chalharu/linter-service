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
const expressionDescription =
	"Syntax and semantics checks for expressions embedded with $" +
	"{{ }} syntax";
const expressionSnippet =
	'      - run: echo "' +
	"$" +
	'{{ github.ref "\n                                  ^';

// Native SARIF as emitted by `actionlint -format "$(cat sarif_template.txt)"`
const nativeSarif = {
	$schema:
		"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
	version: "2.1.0",
	runs: [
		{
			tool: {
				driver: {
					name: "GitHub Actions lint",
					version: "1.7.12",
					informationUri: "https://github.com/rhysd/actionlint",
					rules: [
						{
							id: "expression",
							name: "Expression",
							defaultConfiguration: { level: "error" },
							properties: {
								description: expressionDescription,
								queryURI:
									"https://github.com/rhysd/actionlint/blob/main/docs/checks.md",
							},
							fullDescription: {
								text: expressionDescription,
							},
							helpUri:
								"https://github.com/rhysd/actionlint/blob/main/docs/checks.md",
						},
					],
				},
			},
			results: [
				{
					ruleId: "expression",
					message: {
						text: "got unexpected character '\"' while lexing expression",
					},
					locations: [
						{
							physicalLocation: {
								artifactLocation: {
									uri: ".github/workflows/ci.yml",
									uriBaseId: "%SRCROOT%",
								},
								region: {
									startLine: 7,
									startColumn: 35,
									endColumn: 35,
									snippet: {
										text: expressionSnippet,
									},
								},
							},
						},
					],
				},
			],
		},
	],
};

test("prefers embedded actionlint SARIF when available", () => {
	const context = makeTempRepo("render-linter-sarif-actionlint-");

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
			LINTER_NAME: "actionlint",
			OUTPUT_PATH: path.join(context.runnerTemp, "actionlint.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(report.sarif.runs[0].results[0].ruleId, "expression");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			".github/workflows/ci.yml",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			7,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			35,
		);
		assert.match(
			report.sarif.runs[0].results[0].message.text,
			/got unexpected character/,
		);
		// Rules are sourced from native SARIF
		assert.equal(report.sarif.runs[0].tool.driver.rules[0].id, "expression");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
