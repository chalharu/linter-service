const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { aggregateSarif } = require("./aggregate-sarif.js");

test("aggregates per-linter SARIF files into one linter-service document", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-sarif-"));
	const inputRoot = path.join(tempDir, "input");
	const outputPath = path.join(tempDir, "output", "linter-service.sarif");

	fs.mkdirSync(inputRoot, { recursive: true });
	fs.writeFileSync(
		path.join(inputRoot, "linter-sarif-actionlint.sarif"),
		JSON.stringify(
			{
				version: "2.1.0",
				runs: [
					{
						automationDetails: { id: "linter-service/actionlint" },
						results: [
							{
								message: { text: "Workflow issue" },
								partialFingerprints: {
									primaryLocationLineHash: "abc123",
								},
								properties: {
									linter_name: "actionlint",
								},
								ruleId: "ACT100",
							},
						],
						tool: {
							driver: {
								name: "linter-service/actionlint",
								rules: [
									{
										id: "ACT100",
										shortDescription: {
											text: "ACT100",
										},
									},
								],
							},
						},
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		path.join(inputRoot, "empty-hadolint.sarif"),
		JSON.stringify(
			{
				version: "2.1.0",
				runs: [
					{
						automationDetails: { id: "linter-service/hadolint" },
						results: [],
						tool: {
							driver: {
								name: "linter-service/hadolint",
								rules: [],
							},
						},
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		const report = aggregateSarif({ inputRoot, outputPath });
		const sarif = JSON.parse(fs.readFileSync(outputPath, "utf8"));

		assert.deepEqual(report, {
			fileCount: 2,
			outputPath,
			runCount: 2,
		});
		assert.equal(sarif.version, "2.1.0");
		assert.equal(sarif.runs.length, 2);
		assert.equal(sarif.runs[0].tool.driver.name, "linter-service");
		assert.equal(sarif.runs[0].properties.linter_name, "hadolint");
		assert.deepEqual(sarif.runs[0].results, []);
		assert.equal(sarif.runs[1].tool.driver.name, "linter-service");
		assert.equal(sarif.runs[1].properties.linter_name, "actionlint");
		assert.equal(sarif.runs[1].results[0].ruleId, "actionlint/ACT100");
		assert.equal(
			sarif.runs[1].results[0].message.text,
			"[actionlint] Workflow issue",
		);
		assert.equal(
			sarif.runs[1].results[0].properties.original_rule_id,
			"ACT100",
		);
		assert.match(
			sarif.runs[1].results[0].partialFingerprints.primaryLocationLineHash,
			/^[a-f0-9]{64}$/u,
		);
		assert.equal(sarif.runs[1].tool.driver.rules[0].id, "actionlint/ACT100");
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
