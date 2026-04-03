const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	readPatterns,
	selectFiles,
	selectLinters,
} = require("./linter-targeting.js");

test("selectFiles applies linter patterns and exclude globs", () => {
	const selected = selectFiles({
		candidatePaths: [
			".github/workflows/test.yml",
			".github/workflows/generated/output.yml",
			"docs/guide.md",
		],
		linterName: "actionlint",
		patterns: ["^\\.github\\/workflows\\/.+\\.(?:yaml|yml)$"],
		serviceConfig: {
			global: {
				exclude_paths: [".github/workflows/generated/**"],
			},
			linters: {},
		},
	});

	assert.deepEqual(selected, [".github/workflows/test.yml"]);
});

test("selectLinters skips disabled linters and returns matching names", () => {
	const selected = selectLinters({
		candidatePaths: ["src/index.js", ".github/workflows/test.yml"],
		definitions: [
			{
				name: "actionlint",
				patterns: ["^\\.github\\/workflows\\/.+\\.(?:yaml|yml)$"],
			},
			{
				name: "biome",
				patterns: ["\\.(?:js|ts)$"],
			},
			{
				name: "yamllint",
				patterns: ["\\.(?:yaml|yml)$"],
			},
		],
		serviceConfig: {
			global: {
				exclude_paths: [],
			},
			linters: {
				yamllint: {
					disabled: true,
					exclude_paths: [],
				},
			},
		},
	});

	assert.deepEqual(selected, ["actionlint", "biome"]);
});

test("readPatterns trims blank lines", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	const patternPath = path.join(tempDir, "patterns.txt");

	fs.writeFileSync(patternPath, "\nfoo\n\nbar\n", "utf8");

	try {
		assert.deepEqual(readPatterns(patternPath), ["foo", "bar"]);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
