const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./cargo-linter-test-lib.js");
const prepareDeselectedSarif = require("./prepare-deselected-sarif.js");

test("writes empty SARIF files for enabled deselected linters", () => {
	const context = makeTempRepo("prepare-deselected-sarif-");
	const configPath = path.join(context.tempDir, "config.json");
	const outputRoot = path.join(context.tempDir, "sarif");

	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: [
					{
						name: "actionlint",
						sarif: {
							enabled: true,
						},
					},
					{
						name: "hadolint",
						sarif: {
							category: "custom/hadolint",
							enabled: true,
							tool_name: "custom-hadolint",
						},
					},
					{
						name: "ruff",
					},
				],
			},
			null,
			2,
		),
	);

	try {
		const report = prepareDeselectedSarif({
			configPath,
			outputRoot,
			selectedLintersJson: JSON.stringify(["hadolint"]),
		});

		assert.deepEqual(report, { outputRoot, prepared: 1 });

		const fileNames = fs.readdirSync(outputRoot).sort();
		assert.deepEqual(fileNames, ["empty-actionlint.sarif"]);

		const sarif = JSON.parse(
			fs.readFileSync(path.join(outputRoot, "empty-actionlint.sarif"), "utf8"),
		);
		assert.equal(
			sarif.runs[0].automationDetails.id,
			"linter-service/actionlint",
		);
		assert.equal(sarif.runs[0].tool.driver.name, "linter-service/actionlint");
		assert.deepEqual(sarif.runs[0].results, []);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("returns without writing files when every enabled linter is selected", () => {
	const context = makeTempRepo("prepare-deselected-sarif-none-");
	const configPath = path.join(context.tempDir, "config.json");
	const outputRoot = path.join(context.tempDir, "sarif");

	writeFile(
		configPath,
		JSON.stringify(
			{
				linters: [
					{
						name: "actionlint",
						sarif: {
							enabled: true,
						},
					},
				],
			},
			null,
			2,
		),
	);

	try {
		const report = prepareDeselectedSarif({
			configPath,
			outputRoot,
			selectedLintersJson: JSON.stringify(["actionlint"]),
		});

		assert.deepEqual(report, { outputRoot, prepared: 0 });
		assert.deepEqual(fs.readdirSync(outputRoot), []);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
