const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	buildLinterJobAssignments,
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

test("selectLinters includes linters whose config trigger paths changed", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	fs.writeFileSync(path.join(context, ".textlintrc"), "{}\n", "utf8");

	try {
		const selected = selectLinters({
			candidatePaths: [".textlintrc"],
			definitions: [
				{
					name: "textlint",
					config_trigger_patterns: ["^\\.textlintrc$"],
					patterns: ["\\.(?:md|markdown|txt)$"],
					required_root_files: [".textlintrc"],
				},
			],
			repositoryPath: context,
			serviceConfig: {
				global: {
					exclude_paths: [],
				},
				linters: {},
			},
		});

		assert.deepEqual(selected, ["textlint"]);
	} finally {
		fs.rmSync(context, { force: true, recursive: true });
	}
});

test("selectLinters requires explicit enablement for default-disabled linters", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	fs.writeFileSync(path.join(context, ".textlintrc"), "{}\n", "utf8");

	try {
		const selectedWithoutEnable = selectLinters({
			candidatePaths: ["README.md"],
			definitions: [
				{
					default_disabled: true,
					name: "textlint",
					patterns: ["\\.(?:md|markdown|txt)$"],
					required_root_files: [".textlintrc"],
				},
			],
			repositoryPath: context,
			serviceConfig: {
				global: {
					exclude_paths: [],
				},
				linters: {},
			},
		});
		const selectedWithEnable = selectLinters({
			candidatePaths: ["README.md"],
			definitions: [
				{
					default_disabled: true,
					name: "textlint",
					patterns: ["\\.(?:md|markdown|txt)$"],
					required_root_files: [".textlintrc"],
				},
			],
			repositoryPath: context,
			serviceConfig: {
				global: {
					exclude_paths: [],
				},
				linters: {
					textlint: {
						disabled: false,
						disabled_explicit: true,
						exclude_paths: [],
						preset_package: "textlint-rule-preset-ja-technical-writing@12.0.2",
					},
				},
			},
		});

		assert.deepEqual(selectedWithoutEnable, []);
		assert.deepEqual(selectedWithEnable, ["textlint"]);
	} finally {
		fs.rmSync(context, { force: true, recursive: true });
	}
});

test("selectLinters skips linters whose required root files are missing", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));

	try {
		const selected = selectLinters({
			candidatePaths: ["README.md"],
			definitions: [
				{
					name: "textlint",
					patterns: ["\\.(?:md|markdown|txt)$"],
					required_root_files: [".textlintrc"],
				},
			],
			repositoryPath: context,
			serviceConfig: {
				global: {
					exclude_paths: [],
				},
				linters: {},
			},
		});

		assert.deepEqual(selected, []);
	} finally {
		fs.rmSync(context, { force: true, recursive: true });
	}
});

test("selectLinters rejects invalid config trigger patterns", () => {
	assert.throws(
		() =>
			selectLinters({
				candidatePaths: [".textlintrc"],
				definitions: [
					{
						name: "textlint",
						config_trigger_patterns: [""],
						patterns: ["\\.(?:md|markdown|txt)$"],
					},
				],
				serviceConfig: {
					global: {
						exclude_paths: [],
					},
					linters: {},
				},
			}),
		/config_trigger_patterns must be an array of non-empty strings/u,
	);
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

test("buildLinterJobAssignments groups selected linters in definition order", () => {
	const assignments = buildLinterJobAssignments({
		definitions: [
			{
				execution_group: "github-actions",
				name: "actionlint",
				patterns: ["workflow"],
			},
			{
				execution_group: "github-actions",
				name: "ghalint",
				patterns: ["workflow"],
			},
			{
				name: "biome",
				patterns: ["js"],
			},
			{
				execution_group: "yaml",
				name: "yamllint",
				patterns: ["yaml"],
			},
			{
				execution_group: "yaml",
				name: "yamlfmt",
				patterns: ["yaml"],
			},
		],
		selectedLinters: ["biome", "yamlfmt", "ghalint", "yamllint", "actionlint"],
	});

	assert.deepEqual(assignments, [
		{
			artifact_name: "group-github-actions",
			linter_names: ["actionlint", "ghalint"],
			name: "actionlint + ghalint",
		},
		{
			artifact_name: "biome",
			linter_names: ["biome"],
			name: "biome",
		},
		{
			artifact_name: "group-yaml",
			linter_names: ["yamllint", "yamlfmt"],
			name: "yamllint + yamlfmt",
		},
	]);
});

test("buildLinterJobAssignments rejects invalid execution group names", () => {
	assert.throws(
		() =>
			buildLinterJobAssignments({
				definitions: [
					{
						execution_group: "yaml fast",
						name: "yamllint",
						patterns: ["yaml"],
					},
				],
				selectedLinters: ["yamllint"],
			}),
		/execution_group must contain only/u,
	);
});
