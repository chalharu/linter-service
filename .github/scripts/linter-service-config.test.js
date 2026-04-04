const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	filterExcludedPaths,
	getTextlintPresetPackages,
	isLinterEnabled,
	isPathExcluded,
	loadLinterServiceConfig,
	normalizeGlobPattern,
} = require("./linter-service-config.js");

function makeTempRepo() {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-config-"),
	);
	const repoDir = path.join(tempDir, "repo");
	fs.mkdirSync(path.join(repoDir, ".github"), { recursive: true });
	return { repoDir, tempDir };
}

function cleanupTempRepo(tempDir) {
	fs.rmSync(tempDir, { force: true, recursive: true });
}

function writeLinterServiceConfig(
	repoDir,
	value,
	fileName = "linter-service.yaml",
) {
	const configPath = path.join(repoDir, ".github", fileName);
	const source = fileName.endsWith(".json")
		? `${JSON.stringify(value, null, 2)}\n`
		: `${serializeSimpleYaml(value)}\n`;
	fs.writeFileSync(configPath, source, "utf8");
	return configPath;
}

function serializeSimpleYaml(value, indent = 0) {
	const indentation = " ".repeat(indent);

	if (Array.isArray(value)) {
		return value
			.map((entry) => {
				if (isYamlCollection(entry)) {
					return `${indentation}-\n${serializeSimpleYaml(entry, indent + 2)}`;
				}

				return `${indentation}- ${serializeSimpleYamlScalar(entry)}`;
			})
			.join("\n");
	}

	if (isYamlCollection(value)) {
		return Object.entries(value)
			.map(([key, entry]) => {
				if (isYamlCollection(entry)) {
					return `${indentation}${key}:\n${serializeSimpleYaml(entry, indent + 2)}`;
				}

				return `${indentation}${key}: ${serializeSimpleYamlScalar(entry)}`;
			})
			.join("\n");
	}

	return serializeSimpleYamlScalar(value);
}

function isYamlCollection(value) {
	return Boolean(value) && typeof value === "object";
}

function serializeSimpleYamlScalar(value) {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null) {
		return "null";
	}

	throw new TypeError(`unsupported YAML scalar: ${value}`);
}

test("returns the default config when .github/linter-service.yaml is missing", () => {
	const context = makeTempRepo();

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(config.exists, false);
		assert.equal(
			config.configPath,
			path.join(context.repoDir, ".github", "linter-service.yaml"),
		);
		assert.deepEqual(config.global.exclude_paths, []);
		assert.deepEqual(config.linters, {});
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("falls back to .github/linter-service.json when YAML is absent", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(
		context.repoDir,
		{
			linters: {
				actionlint: {
					disabled: true,
				},
			},
		},
		"linter-service.json",
	);

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(config.exists, true);
		assert.equal(
			config.configPath,
			path.join(context.repoDir, ".github", "linter-service.json"),
		);
		assert.equal(isLinterEnabled(config, "actionlint"), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("prefers YAML over JSON when both config files exist", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			actionlint: {
				disabled: false,
			},
		},
	});
	writeLinterServiceConfig(
		context.repoDir,
		{
			linters: {
				actionlint: {
					disabled: true,
				},
			},
		},
		"linter-service.json",
	);

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(
			config.configPath,
			path.join(context.repoDir, ".github", "linter-service.yaml"),
		);
		assert.equal(isLinterEnabled(config, "actionlint"), true);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("loads global and per-linter exclude globs with directory normalization", () => {
	const context = makeTempRepo();
	writeLinterServiceConfig(context.repoDir, {
		global: {
			exclude_paths: [
				"**/tests/*/target/**",
				"**/tests/*/sarif.json",
				"./vendor/",
			],
		},
		linters: {
			yamllint: {
				exclude_paths: ["docs/generated/"],
			},
		},
	});

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(config.exists, true);
		assert.deepEqual(config.global.exclude_paths, [
			"**/tests/*/target/**",
			"**/tests/*/sarif.json",
			"vendor/**",
		]);
		assert.deepEqual(config.linters.yamllint.exclude_paths, [
			"docs/generated/**",
		]);
		assert.equal(
			isPathExcluded(
				config,
				"yamllint",
				"actionlint/tests/pass/target/file.yml",
			),
			true,
		);
		assert.equal(
			isPathExcluded(
				config,
				"yamllint",
				"dotenv-linter/tests/pass/target/.env",
			),
			true,
		);
		assert.equal(
			isPathExcluded(
				config,
				"yamllint",
				"actionlint/tests/pass/target/.github/workflows/test.yml",
			),
			true,
		);
		assert.equal(
			isPathExcluded(config, "yamllint", "actionlint/tests/pass/sarif.json"),
			true,
		);
		assert.equal(
			isPathExcluded(config, "yamllint", "docs/generated/schema.yml"),
			true,
		);
		assert.equal(isPathExcluded(config, "yamllint", "docs/guide.yml"), false);
		assert.equal(
			isPathExcluded(config, "yamllint", "actionlint/tests/pass/result.json"),
			false,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("supports per-linter disable flags", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			actionlint: {
				disabled: true,
			},
			ghalint: {
				disabled: false,
			},
		},
	});

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(isLinterEnabled(config, "actionlint"), false);
		assert.equal(isLinterEnabled(config, "ghalint"), true);
		assert.equal(isLinterEnabled(config, "yamllint"), true);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("supports textlint preset_packages when textlint is enabled", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: ["textlint-rule-preset-ja-technical-writing@12.0.2"],
			},
		},
	});

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(isLinterEnabled(config, "textlint"), true);
		assert.deepEqual(getTextlintPresetPackages(config), [
			"textlint-rule-preset-ja-technical-writing@12.0.2",
		]);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("requires textlint preset_packages when textlint is enabled", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
			},
		},
	});

	try {
		assert.throws(
			() =>
				loadLinterServiceConfig({
					repositoryPath: context.repoDir,
				}),
			/preset_packages is required/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("supports multiple textlint preset_packages", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: [
					"textlint-rule-preset-ja-technical-writing@12.0.2",
					"textlint-rule-preset-ja-spacing@4.0.0",
				],
			},
		},
	});

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(isLinterEnabled(config, "textlint"), true);
		assert.deepEqual(getTextlintPresetPackages(config), [
			"textlint-rule-preset-ja-technical-writing@12.0.2",
			"textlint-rule-preset-ja-spacing@4.0.0",
		]);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("textlint remains disabled when configured disabled", () => {
	const config = {
		global: {
			exclude_paths: [],
		},
		linters: {
			textlint: {
				disabled: true,
				disabled_explicit: true,
				exclude_paths: [],
				preset_packages: ["textlint-rule-preset-ja-technical-writing@12.0.2"],
			},
		},
	};

	assert.equal(isLinterEnabled(config, "textlint"), false);
});

test("rejects invalid textlint preset package configuration", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: ["textlint-rule-preset-ja-technical-writing"],
			},
		},
	});

	try {
		assert.throws(
			() =>
				loadLinterServiceConfig({
					repositoryPath: context.repoDir,
				}),
			/exact version/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("rejects duplicate textlint preset package names", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: [
					"textlint-rule-preset-ja-technical-writing@12.0.2",
					"textlint-rule-preset-ja-technical-writing@12.0.3",
				],
			},
		},
	});

	try {
		assert.throws(
			() =>
				loadLinterServiceConfig({
					repositoryPath: context.repoDir,
				}),
			/duplicate package names/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("rejects legacy textlint preset_package", () => {
	const context = makeTempRepo();

	writeLinterServiceConfig(context.repoDir, {
		linters: {
			textlint: {
				disabled: false,
				preset_package: "textlint-rule-preset-ja-technical-writing@12.0.2",
			},
		},
	});

	try {
		assert.throws(
			() =>
				loadLinterServiceConfig({
					repositoryPath: context.repoDir,
				}),
			/no longer supported/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("filters excluded paths while preserving remaining order", () => {
	const config = {
		global: {
			exclude_paths: ["**/tests/*/target/**", "**/tests/*/sarif.json"],
		},
		linters: {
			biome: {
				disabled: false,
				exclude_paths: ["vendor/**"],
			},
		},
	};

	assert.deepEqual(
		filterExcludedPaths(config, "biome", [
			"src/index.js",
			"vendor/schema.json",
			"biome/tests/pass/target/file.js",
			"dotenv-linter/tests/pass/target/.env",
			"actionlint/tests/pass/target/.github/workflows/test.yml",
			"shellcheck/tests/pass/sarif.json",
			"shellcheck/tests/pass/result.json",
			"src/lib.js",
		]),
		["src/index.js", "shellcheck/tests/pass/result.json", "src/lib.js"],
	);
});

test("matches hidden descendants for directory exclude globs", () => {
	const config = {
		global: {
			exclude_paths: ["fixtures/**"],
		},
		linters: {},
	};

	assert.equal(isPathExcluded(config, "shellcheck", "fixtures/.env"), true);
	assert.equal(
		isPathExcluded(config, "shellcheck", "fixtures/.github/workflows/test.yml"),
		true,
	);
	assert.equal(
		isPathExcluded(config, "shellcheck", "fixtures/scripts/.config/tool.yml"),
		true,
	);
	assert.equal(
		isPathExcluded(config, "shellcheck", "fixture/result.json"),
		false,
	);
});

test("rejects invalid config shapes", () => {
	const context = makeTempRepo();

	fs.writeFileSync(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify({
			global: [],
		}),
		"utf8",
	);

	try {
		assert.throws(
			() =>
				loadLinterServiceConfig({
					repositoryPath: context.repoDir,
				}),
			/global config must be an object/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("normalizes directory globs by appending **", () => {
	assert.equal(normalizeGlobPattern("fixtures/"), "fixtures/**");
	assert.equal(normalizeGlobPattern("./fixtures/"), "fixtures/**");
});
