const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	filterExcludedPaths,
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

test("returns the default config when .github/linter-service.json is missing", () => {
	const context = makeTempRepo();

	try {
		const config = loadLinterServiceConfig({
			repositoryPath: context.repoDir,
		});

		assert.equal(config.exists, false);
		assert.deepEqual(config.global.exclude_paths, []);
		assert.deepEqual(config.linters, {});
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("loads global and per-linter exclude globs with directory normalization", () => {
	const context = makeTempRepo();
	const configPath = path.join(
		context.repoDir,
		".github",
		"linter-service.json",
	);

	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
		"utf8",
	);

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

	fs.writeFileSync(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				linters: {
					actionlint: {
						disabled: true,
					},
					ghalint: {
						disabled: false,
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);

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
