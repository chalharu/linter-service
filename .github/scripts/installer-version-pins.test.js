const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..");

function createJavaScriptRegExpFromRenovatePattern(pattern) {
	let flags = "g";
	let source = pattern;

	if (source.startsWith("(?m)")) {
		flags += "m";
		source = source.slice(4);
	}

	return new RegExp(source, flags);
}

const installerExpectations = [
	{
		path: "actionlint/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=rhysd\/actionlint/u,
			/actionlint_version="[^"\n]+"/u,
			/releases\/download\/\$actionlint_version\//u,
		],
	},
	{
		path: "ghalint/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=suzuki-shunsuke\/ghalint/u,
			/ghalint_version="[^"\n]+"/u,
			/releases\/download\/\$ghalint_version\//u,
		],
	},
	{
		path: "hadolint/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=hadolint\/hadolint/u,
			/hadolint_version="[^"\n]+"/u,
			/releases\/download\/\$hadolint_version\//u,
		],
	},
	{
		path: "helmlint/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=helm\/helm/u,
			/helm_version="[^"\n]+"/u,
			/asset="helm-\$\{helm_version\}-linux-amd64\.tar\.gz"/u,
			/get\.helm\.sh\/\$asset/u,
		],
	},
	{
		path: "dotenv-linter/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=dotenv-linter\/dotenv-linter/u,
			/dotenv_linter_version="[^"\n]+"/u,
			/releases\/download\/\$dotenv_linter_version\//u,
		],
	},
	{
		path: "editorconfig-checker/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=editorconfig-checker\/editorconfig-checker/u,
			/editorconfig_checker_version="[^"\n]+"/u,
			/releases\/download\/\$editorconfig_checker_version\//u,
		],
	},
	{
		path: "shellcheck/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=koalaman\/shellcheck/u,
			/shellcheck_version="[^"\n]+"/u,
			/releases\/download\/\$shellcheck_version\//u,
		],
	},
	{
		path: "taplo/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=tamasfe\/taplo/u,
			/taplo_version="[^"\n]+"/u,
			/releases\/download\/\$taplo_version\//u,
		],
	},
	{
		path: "cargo-deny/install.sh",
		required: [
			/# renovate: datasource=rust depName=rust versioning=semver/u,
			/rust_toolchain_version="[^"\n]+"/u,
			/--default-toolchain "\$rust_toolchain_version"/u,
			/# renovate: datasource=github-releases depName=EmbarkStudios\/cargo-deny/u,
			/cargo_deny_version="[^"\n]+"/u,
			/releases\/download\/\$cargo_deny_version\//u,
		],
	},
	{
		path: "yamlfmt/install.sh",
		required: [
			/# renovate: datasource=github-releases depName=google\/yamlfmt/u,
			/yamlfmt_version="[^"\n]+"/u,
			/releases\/download\/\$yamlfmt_version\//u,
		],
	},
	{
		path: "biome/install.sh",
		required: [
			/# renovate: datasource=npm depName=@biomejs\/biome/u,
			/biome_version="[^"\n]+"/u,
			/@biomejs\/biome@\$biome_version/u,
		],
	},
	{
		path: "markdownlint-cli2/install.sh",
		required: [
			/# renovate: datasource=npm depName=markdownlint-cli2/u,
			/markdownlint_cli2_version="[^"\n]+"/u,
			/markdownlint-cli2@\$markdownlint_cli2_version/u,
		],
	},
	{
		path: "renovate/install.sh",
		required: [
			/# renovate: datasource=npm depName=renovate/u,
			/renovate_version="[^"\n]+"/u,
			/renovate_image_tag "\$base_image" "\$renovate_version"/u,
			/RENOVATE_VERSION=\$renovate_version/u,
		],
	},
	{
		path: "spectral/install.sh",
		required: [
			/# renovate: datasource=npm depName=@stoplight\/spectral-cli/u,
			/spectral_version="[^"\n]+"/u,
			/@stoplight\/spectral-cli@\$spectral_version/u,
		],
	},
	{
		path: "yamllint/install.sh",
		required: [
			/# renovate: datasource=pypi depName=yamllint/u,
			/yamllint_version="[^"\n]+"/u,
			/yamllint==\$yamllint_version/u,
		],
	},
	{
		path: "lizard/install.sh",
		required: [
			/# renovate: datasource=pypi depName=lizard/u,
			/lizard_version="[^"\n]+"/u,
			/lizard==\$lizard_version/u,
		],
	},
	{
		path: "zizmor/install.sh",
		required: [
			/# renovate: datasource=pypi depName=zizmor/u,
			/zizmor_version="[^"\n]+"/u,
			/zizmor==\$zizmor_version/u,
		],
	},
	{
		path: "ruff/install.sh",
		required: [
			/# renovate: datasource=pypi depName=ruff/u,
			/ruff_version="[^"\n]+"/u,
			/ruff==\$ruff_version/u,
		],
	},
	{
		path: "rustfmt/install.sh",
		required: [
			/# renovate: datasource=rust depName=rust versioning=semver/u,
			/rust_toolchain_version="[^"\n]+"/u,
			/--default-toolchain "\$rust_toolchain_version"/u,
		],
	},
	{
		path: "textlint/install.sh",
		required: [
			/# renovate: datasource=npm depName=textlint/u,
			/textlint_version="[^"\n]+"/u,
			/textlint@\$\{textlint_version\}/u,
		],
	},
];

test("installer scripts use renovate-managed pinned versions", () => {
	for (const expectation of installerExpectations) {
		const source = fs.readFileSync(
			path.join(repoRoot, expectation.path),
			"utf8",
		);

		for (const pattern of expectation.required) {
			assert.match(source, pattern, expectation.path);
		}

		assert.doesNotMatch(source, /resolve_latest_github_release_tag/u);
	}
});

test("renovate manages installer pins with a three day hold", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);

	assert.ok(config.enabledManagers.includes("custom.regex"));
	assert.ok(Array.isArray(config.customManagers));
	assert.ok(
		config.customManagers.some(
			(manager) =>
				manager.customType === "regex" &&
				Array.isArray(manager.managerFilePatterns) &&
				manager.managerFilePatterns.includes("/(^|/)[^/]+/install\\.sh$/") &&
				manager.managerFilePatterns.includes("/(^|/)renovate/Dockerfile$/"),
		),
	);
	assert.ok(
		config.packageRules.some(
			(rule) =>
				Array.isArray(rule.matchManagers) &&
				rule.matchManagers.includes("custom.regex") &&
				rule.minimumReleaseAge === "3 days",
		),
	);
});

test("renovate Dockerfile uses a renovate-managed pinned slim base image", () => {
	const dockerfile = fs.readFileSync(
		path.join(repoRoot, "renovate", "Dockerfile"),
		"utf8",
	);

	assert.match(
		dockerfile,
		/# renovate: datasource=docker depName=library\/node versioning=docker/u,
	);
	assert.match(
		dockerfile,
		/ARG RENOVATE_BASE_IMAGE=docker\.io\/library\/node:24-bookworm-slim@sha256:[a-f0-9]{64}/u,
	);
	assert.match(dockerfile, /FROM \$\{RENOVATE_BASE_IMAGE\}/u);
});

test("renovate enables npm package manifest updates", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);

	assert.ok(config.enabledManagers.includes("npm"));

	for (const manifestPath of ["package.json", "worker/package.json"]) {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"),
		);
		const dependencyCount =
			Object.keys(manifest.dependencies ?? {}).length +
			Object.keys(manifest.devDependencies ?? {}).length;

		assert.ok(
			dependencyCount > 0,
			`${manifestPath} should expose npm dependencies for Renovate to update`,
		);
	}
});

test("renovate manages textlint preset package pins from YAML config", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);
	const yamlConfig = fs.readFileSync(
		path.join(repoRoot, ".github", "linter-service.yaml"),
		"utf8",
	);

	assert.ok(
		config.customManagers.some(
			(manager) =>
				manager.customType === "regex" &&
				Array.isArray(manager.managerFilePatterns) &&
				manager.managerFilePatterns.includes(
					"/(^|/)\\.github/linter-service\\.ya?ml$/",
				) &&
				Array.isArray(manager.matchStrings) &&
				manager.matchStrings.some((pattern) =>
					pattern.includes("textlint-rule-preset-"),
				) &&
				manager.datasourceTemplate === "npm",
		),
	);
	assert.match(
		yamlConfig,
		/^\s+- "textlint-rule-preset-ja-technical-writing@12\.0\.2"$/mu,
	);
	assert.match(
		yamlConfig,
		/^\s+- "@textlint-ja\/textlint-rule-preset-ai-writing@1\.6\.1"$/mu,
	);
});

test("renovate custom regex managers avoid RE2 lookaround syntax", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);

	for (const manager of config.customManagers ?? []) {
		if (
			manager.customType !== "regex" ||
			!Array.isArray(manager.matchStrings)
		) {
			continue;
		}

		for (const pattern of manager.matchStrings) {
			assert.equal(typeof pattern, "string");
			assert.doesNotMatch(
				pattern,
				/\(\?(?:!?=|<[=!])/u,
				`custom regex manager must avoid RE2-unsupported lookaround: ${pattern}`,
			);
		}
	}
});

test("renovate textlint preset regex matches all YAML preset packages", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);
	const manager = config.customManagers.find(
		(candidate) =>
			candidate.customType === "regex" &&
			Array.isArray(candidate.managerFilePatterns) &&
			candidate.managerFilePatterns.includes(
				"/(^|/)\\.github/linter-service\\.ya?ml$/",
			),
	);

	assert.ok(manager, "expected YAML regex custom manager");
	assert.ok(Array.isArray(manager.matchStrings), "expected regex matchStrings");

	const yamlConfig = fs.readFileSync(
		path.join(repoRoot, ".github", "linter-service.yaml"),
		"utf8",
	);
	const matches = [
		...yamlConfig.matchAll(
			createJavaScriptRegExpFromRenovatePattern(manager.matchStrings[0]),
		),
	].map(({ groups }) => `${groups.depName}@${groups.currentValue}`);

	assert.deepEqual(matches, [
		"textlint-rule-preset-ja-technical-writing@12.0.2",
		"@textlint-ja/textlint-rule-preset-ai-writing@1.6.1",
	]);
});

test("renovate installer regex matches both Renovate and the pinned base image", () => {
	const config = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "renovate.json"), "utf8"),
	);
	const manager = config.customManagers.find(
		(candidate) =>
			candidate.customType === "regex" &&
			Array.isArray(candidate.managerFilePatterns) &&
			candidate.managerFilePatterns.includes("/(^|/)[^/]+/install\\.sh$/") &&
			candidate.managerFilePatterns.includes("/(^|/)renovate/Dockerfile$/"),
	);

	assert.ok(manager, "expected installer regex custom manager");
	assert.ok(Array.isArray(manager.matchStrings), "expected regex matchStrings");

	const installScript = fs.readFileSync(
		path.join(repoRoot, "renovate", "install.sh"),
		"utf8",
	);
	const dockerfile = fs.readFileSync(
		path.join(repoRoot, "renovate", "Dockerfile"),
		"utf8",
	);
	const matches = manager.matchStrings
		.flatMap((pattern) => [
			...installScript.matchAll(
				createJavaScriptRegExpFromRenovatePattern(pattern),
			),
			...dockerfile.matchAll(
				createJavaScriptRegExpFromRenovatePattern(pattern),
			),
		])
		.map(({ groups }) => `${groups.depName}@${groups.currentValue}`);

	assert.deepEqual(matches, [
		"renovate@43.104.4",
		"library/node@docker.io/library/node:24-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c",
	]);
});

test("root shared Node dependencies use exact version pins", () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
	);

	assert.match(manifest.dependencies["js-yaml"], /^\d+\.\d+\.\d+$/u);
});
