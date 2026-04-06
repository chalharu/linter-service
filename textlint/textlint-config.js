const fs = require("node:fs");
const path = require("node:path");

const {
	getLinterConfig,
	isLinterEnabled,
	loadLinterServiceConfig,
} = require("../.github/scripts/linter-service-config.js");
const { getTextlintPresetRuleKey } = require("./textlint-preset-package.js");
const {
	parseExactPackageSpec,
} = require("../.github/scripts/npm-package-spec.js");

function resolveTextlintRuntime({ repositoryPath, outputPath }) {
	const resolvedRepositoryPath = requireRepositoryPath(repositoryPath);
	const serviceConfig = loadLinterServiceConfig({
		repositoryPath: resolvedRepositoryPath,
	});
	const serviceConfigPath = formatRepositoryRelativePath(
		resolvedRepositoryPath,
		serviceConfig.configPath,
	);

	if (!isLinterEnabled(serviceConfig, "textlint")) {
		throw new Error(`textlint is disabled in ${serviceConfigPath}`);
	}

	const presetPackages = getLinterConfig(
		serviceConfig,
		"textlint",
	).preset_packages;
	if (!Array.isArray(presetPackages) || presetPackages.length === 0) {
		throw new Error(
			`textlint requires linters.textlint.preset_packages in ${serviceConfigPath}`,
		);
	}

	const resolvedPresetPackages = presetPackages.map((presetPackage, index) =>
		parseExactPackageSpec(
			presetPackage,
			`linters.textlint.preset_packages[${index}]`,
		),
	);
	const configPath = path.join(resolvedRepositoryPath, ".textlintrc");
	const config = buildSafeTextlintConfig({
		config: loadStaticTextlintConfig({ configPath }),
		presetPackages: resolvedPresetPackages,
	});

	if (typeof outputPath === "string" && outputPath.length > 0) {
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(
			outputPath,
			`${JSON.stringify(config, null, 2)}\n`,
			"utf8",
		);
	}

	return {
		configPath,
		presetPackages: resolvedPresetPackages,
	};
}

function loadStaticTextlintConfig({ configPath }) {
	if (typeof configPath !== "string" || configPath.length === 0) {
		throw new Error("configPath is required");
	}

	if (!fs.existsSync(configPath)) {
		throw new Error(
			"textlint requires a repository-root .textlintrc file before it can run",
		);
	}

	let source = fs.readFileSync(configPath, "utf8");
	if (source.charCodeAt(0) === 0xfeff) {
		source = source.slice(1);
	}

	let parsed;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error(
			"shared textlint only supports static JSON .textlintrc without comments, YAML, or JavaScript",
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(".textlintrc must contain a JSON object");
	}

	return parsed;
}

function buildSafeTextlintConfig({ config, presetPackages }) {
	const safeConfig = structuredClone(config);

	if (!Object.hasOwn(safeConfig, "rules")) {
		safeConfig.rules = {};
	} else if (
		typeof safeConfig.rules !== "object" ||
		safeConfig.rules === null ||
		Array.isArray(safeConfig.rules)
	) {
		throw new Error(".textlintrc rules must contain a JSON object");
	}

	for (const presetPackage of presetPackages) {
		const presetRuleKey = getTextlintPresetRuleKey(presetPackage.name);
		if (!(presetRuleKey in safeConfig.rules)) {
			safeConfig.rules[presetRuleKey] = true;
		}
	}

	return safeConfig;
}

function requireRepositoryPath(repositoryPath) {
	if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
		throw new Error("repositoryPath is required");
	}

	return path.resolve(repositoryPath);
}

function formatRepositoryRelativePath(repositoryPath, filePath) {
	return path.relative(repositoryPath, filePath).split(path.sep).join("/");
}

module.exports = {
	buildSafeTextlintConfig,
	getTextlintPresetRuleKey,
	loadStaticTextlintConfig,
	resolveTextlintRuntime,
};
