const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	loadStaticTextlintConfig,
	resolveTextlintRuntime,
} = require("./textlint-config.js");

function makeTempRepo() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "textlint-config-"));
	const repoDir = path.join(tempDir, "repo");
	fs.mkdirSync(path.join(repoDir, ".github"), { recursive: true });
	return { repoDir, tempDir };
}

function cleanupTempRepo(tempDir) {
	fs.rmSync(tempDir, { force: true, recursive: true });
}

test("resolveTextlintRuntime requires explicit enablement and writes a safe config copy", () => {
	const context = makeTempRepo();
	const outputPath = path.join(context.tempDir, "safe", ".textlintrc");

	fs.writeFileSync(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				linters: {
					textlint: {
						disabled: false,
						preset_package: "textlint-rule-preset-ja-technical-writing@12.0.2",
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		path.join(context.repoDir, ".textlintrc"),
		JSON.stringify(
			{
				rules: {},
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		const runtime = resolveTextlintRuntime({
			outputPath,
			repositoryPath: context.repoDir,
		});

		assert.equal(
			runtime.presetPackageName,
			"textlint-rule-preset-ja-technical-writing",
		);
		assert.equal(
			runtime.presetPackageSpec,
			"textlint-rule-preset-ja-technical-writing@12.0.2",
		);
		assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
			rules: {},
		});
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("loadStaticTextlintConfig rejects non-JSON .textlintrc content", () => {
	const context = makeTempRepo();
	const configPath = path.join(context.repoDir, ".textlintrc");

	fs.writeFileSync(configPath, "module.exports = {};\n", "utf8");

	try {
		assert.throws(
			() => loadStaticTextlintConfig({ configPath }),
			/static JSON/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
