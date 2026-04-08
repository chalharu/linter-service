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
				linters: {
					textlint: {
						disabled: false,
						disabled_explicit: true,
						exclude_paths: [],
						preset_packages: [
							"textlint-rule-preset-ja-technical-writing@12.0.2",
						],
					},
				},
			},
		});

		assert.deepEqual(selected, ["textlint"]);
	} finally {
		fs.rmSync(context, { force: true, recursive: true });
	}
});

test("selectLinters ignores exclude paths for config trigger matches", () => {
	const selected = selectLinters({
		candidatePaths: [".github/linter-service.yaml"],
		definitions: [
			{
				default_disabled: true,
				name: "lizard",
				config_trigger_patterns: [
					"^\\.github\\/linter-service\\.(?:json|ya?ml)$",
				],
				patterns: ["\\.(?:js|py)$"],
			},
		],
		linterServicePath: path.join(__dirname, "..", ".."),
		serviceConfig: {
			global: {
				exclude_paths: [".github/**"],
			},
			linters: {
				lizard: {
					disabled: false,
					disabled_explicit: true,
					exclude_paths: [],
					languages: ["javascript"],
				},
			},
		},
	});

	assert.deepEqual(selected, ["lizard"]);
});

test("selectFiles keeps helmlint targets only when a Chart.yaml ancestor exists", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	fs.mkdirSync(path.join(context, "charts", "app", "templates"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(context, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(context, "charts", "app", "Chart.yaml"),
		"apiVersion: v2\nname: app\nversion: 0.1.0\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(context, "charts", "app", "values.yaml"),
		"replicaCount: 1\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(context, "charts", "app", "templates", "deployment.yaml"),
		"apiVersion: v1\nkind: ConfigMap\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(context, "docs", "values.yaml"),
		"title: docs\n",
		"utf8",
	);

	try {
		const selected = selectFiles({
			candidatePaths: [
				"charts/app/values.yaml",
				"docs/values.yaml",
				"charts/app/templates/deployment.yaml",
			],
			linterName: "helmlint",
			patterns: [
				"(?:^|/)values(?:[._-][^/]+)?\\.ya?ml$",
				"(?:^|/)(?:templates|crds)/.+$",
			],
			repositoryPath: context,
			serviceConfig: {
				global: {
					exclude_paths: [],
				},
				linters: {},
			},
		});

		assert.deepEqual(selected, [
			"charts/app/values.yaml",
			"charts/app/templates/deployment.yaml",
		]);
	} finally {
		fs.rmSync(context, { force: true, recursive: true });
	}
});

test("selectLinters skips helmlint when matching files are outside Helm charts", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	fs.mkdirSync(path.join(context, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(context, "docs", "values.yaml"),
		"title: docs\n",
		"utf8",
	);

	try {
		const selected = selectLinters({
			candidatePaths: ["docs/values.yaml"],
			definitions: [
				{
					name: "helmlint",
					patterns: ["(?:^|/)values(?:[._-][^/]+)?\\.ya?ml$"],
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

test("selectLinters skips textlint until preset_packages are configured", () => {
	const context = fs.mkdtempSync(path.join(os.tmpdir(), "linter-targeting-"));
	fs.writeFileSync(path.join(context, ".textlintrc"), "{}\n", "utf8");

	try {
		const selectedWithoutPresetPackages = selectLinters({
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
				linters: {
					textlint: {
						disabled: false,
						disabled_explicit: true,
						exclude_paths: [],
						preset_packages: [],
					},
				},
			},
		});
		const selectedWithPresetPackages = selectLinters({
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
				linters: {
					textlint: {
						disabled: false,
						disabled_explicit: true,
						exclude_paths: [],
						preset_packages: [
							"textlint-rule-preset-ja-technical-writing@12.0.2",
						],
					},
				},
			},
		});

		assert.deepEqual(selectedWithoutPresetPackages, []);
		assert.deepEqual(selectedWithPresetPackages, ["textlint"]);
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

test("selectLinters keeps default-disabled lizard off until explicitly enabled", () => {
	const definitions = [
		{
			default_disabled: true,
			name: "lizard",
			patterns: ["\\.(?:js|py)$"],
		},
	];
	const linterServicePath = path.join(__dirname, "..", "..");

	const selectedWithoutExplicitEnable = selectLinters({
		candidatePaths: ["src/app.js"],
		definitions,
		linterServicePath,
		serviceConfig: {
			global: {
				exclude_paths: [],
			},
			linters: {
				lizard: {
					disabled: false,
					disabled_explicit: false,
					exclude_paths: [],
					languages: ["javascript"],
				},
			},
		},
	});
	const selectedWithMismatchedLanguage = selectLinters({
		candidatePaths: ["src/app.js"],
		definitions,
		linterServicePath,
		serviceConfig: {
			global: {
				exclude_paths: [],
			},
			linters: {
				lizard: {
					disabled: false,
					disabled_explicit: true,
					exclude_paths: [],
					languages: ["python"],
				},
			},
		},
	});
	const selectedWithMatchingLanguage = selectLinters({
		candidatePaths: ["src/app.js"],
		definitions,
		linterServicePath,
		serviceConfig: {
			global: {
				exclude_paths: [],
			},
			linters: {
				lizard: {
					disabled: false,
					disabled_explicit: true,
					exclude_paths: [],
					languages: ["javascript"],
				},
			},
		},
	});

	assert.deepEqual(selectedWithoutExplicitEnable, []);
	assert.deepEqual(selectedWithMismatchedLanguage, []);
	assert.deepEqual(selectedWithMatchingLanguage, ["lizard"]);
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

test("buildLinterJobAssignments batches non-isolated linters and keeps isolated ones separate", () => {
	const assignments = buildLinterJobAssignments({
		definitions: [
			{
				name: "actionlint",
				patterns: ["workflow"],
			},
			{
				name: "ghalint",
				patterns: ["workflow"],
			},
			{
				name: "biome",
				patterns: ["js"],
			},
			{
				name: "yamllint",
				isolated: true,
				patterns: ["yaml"],
			},
			{
				name: "yamlfmt",
				patterns: ["yaml"],
			},
		],
		selectedLinters: ["biome", "yamlfmt", "ghalint", "yamllint", "actionlint"],
	});

	assert.deepEqual(assignments, [
		{
			artifact_name: "shared",
			linter_names: ["actionlint", "ghalint", "biome", "yamlfmt"],
			name: "actionlint + ghalint + biome + yamlfmt",
		},
		{
			artifact_name: "yamllint",
			linter_names: ["yamllint"],
			name: "yamllint",
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

test("buildLinterJobAssignments rejects non-boolean isolated values", () => {
	assert.throws(
		() =>
			buildLinterJobAssignments({
				definitions: [
					{
						isolated: "yes",
						name: "textlint",
						patterns: ["txt"],
					},
				],
				selectedLinters: ["textlint"],
			}),
		/isolated must be a boolean when present/u,
	);
});
