const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const { parseExactPackageSpec } = require("./npm-package-spec.js");
const requireEnv = require("./lib/require-env.js");
const LINTER_SERVICE_CONFIG_CANDIDATES = [
	".github/linter-service.yaml",
	".github/linter-service.yml",
	".github/linter-service.json",
];

function runFromEnv(env = process.env) {
	const repositoryPath = requireEnv(env, "SOURCE_REPOSITORY_PATH");
	return loadLinterServiceConfig({ repositoryPath });
}

function loadLinterServiceConfig({ configPath, repositoryPath } = {}) {
	const resolvedPath = resolveLinterServiceConfigPath({
		configPath,
		repositoryPath,
	});

	if (!fs.existsSync(resolvedPath)) {
		return {
			configPath: resolvedPath,
			exists: false,
			global: {
				exclude_paths: [],
			},
			linters: {},
		};
	}

	const parsed = parseLinterServiceConfigSource({
		configPath: resolvedPath,
		source: fs.readFileSync(resolvedPath, "utf8"),
	});
	const normalized = normalizeLinterServiceConfig(parsed);
	return {
		configPath: resolvedPath,
		exists: true,
		...normalized,
	};
}

function resolveLinterServiceConfigPath({ configPath, repositoryPath } = {}) {
	if (typeof configPath === "string" && configPath.length > 0) {
		return configPath;
	}

	const resolvedRepositoryPath = requireString(
		repositoryPath,
		"repositoryPath",
	);

	for (const relativePath of LINTER_SERVICE_CONFIG_CANDIDATES) {
		const candidatePath = path.join(resolvedRepositoryPath, relativePath);
		if (fs.existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	return path.join(resolvedRepositoryPath, LINTER_SERVICE_CONFIG_CANDIDATES[0]);
}

function parseLinterServiceConfigSource({ configPath, source }) {
	let normalizedSource = String(source);
	if (normalizedSource.charCodeAt(0) === 0xfeff) {
		normalizedSource = normalizedSource.slice(1);
	}

	const extension = path.extname(configPath).toLowerCase();
	if (extension === ".json") {
		return JSON.parse(normalizedSource);
	}

	if (extension === ".yaml" || extension === ".yml") {
		return parseYamlDocument(normalizedSource);
	}

	throw new Error(`unsupported linter-service config format: ${configPath}`);
}

function parseYamlDocument(source) {
	try {
		const parsed = yaml.load(source, {
			schema: yaml.JSON_SCHEMA,
		});
		return parsed === undefined ? {} : parsed;
	} catch (error) {
		throw new Error(`failed to parse linter-service YAML: ${error.message}`);
	}
}

function normalizeLinterServiceConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("linter-service config must be an object");
	}

	const global = normalizeGlobalConfig(value.global);
	const linters = normalizeLinterConfigs(value.linters);

	return { global, linters };
}

function normalizeGlobalConfig(value) {
	if (value === undefined) {
		return {
			exclude_paths: [],
		};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("linter-service global config must be an object");
	}

	return {
		exclude_paths: normalizeGlobList(
			value.exclude_paths,
			"global.exclude_paths",
		),
	};
}

function normalizeLinterConfigs(value) {
	if (value === undefined) {
		return {};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("linter-service linters config must be an object");
	}

	const entries = {};

	for (const [linterName, currentConfig] of Object.entries(value)) {
		if (
			!currentConfig ||
			typeof currentConfig !== "object" ||
			Array.isArray(currentConfig)
		) {
			throw new Error(`linter config for ${linterName} must be an object`);
		}

		if (
			currentConfig.disabled !== undefined &&
			typeof currentConfig.disabled !== "boolean"
		) {
			throw new Error(
				`linter config for ${linterName} must use boolean disabled`,
			);
		}

		const entry = {
			disabled: currentConfig.disabled === true,
			disabled_explicit:
				currentConfig.disabled === true || currentConfig.disabled === false,
			exclude_paths: normalizeGlobList(
				currentConfig.exclude_paths,
				`linters.${linterName}.exclude_paths`,
			),
		};

		if (linterName === "textlint") {
			if (currentConfig.preset_package !== undefined) {
				throw new Error(
					`linters.${linterName}.preset_package is no longer supported; use linters.${linterName}.preset_packages`,
				);
			}

			entry.preset_packages = normalizeTextlintPresetPackages({
				presetPackages: currentConfig.preset_packages,
				label: `linters.${linterName}`,
			});

			if (
				currentConfig.disabled === false &&
				entry.preset_packages.length === 0
			) {
				throw new Error(
					`linters.${linterName}.preset_packages is required when textlint is enabled`,
				);
			}
		}

		entries[linterName] = entry;
	}

	return entries;
}

function normalizeTextlintPresetPackages({ label, presetPackages }) {
	if (presetPackages === undefined) {
		return [];
	}

	if (!Array.isArray(presetPackages)) {
		throw new Error(`${label}.preset_packages must be an array`);
	}

	if (presetPackages.length === 0) {
		throw new Error(`${label}.preset_packages must not be empty`);
	}

	const normalized = presetPackages.map((entry, index) =>
		normalizeExactPackageSpec(entry, `${label}.preset_packages[${index}]`),
	);
	const seenNames = new Set();

	for (const spec of normalized) {
		const { name } = parseExactPackageSpec(spec, `${label}.preset_packages`);
		if (seenNames.has(name)) {
			throw new Error(
				`${label}.preset_packages must not contain duplicate package names`,
			);
		}
		seenNames.add(name);
	}

	return normalized;
}

function normalizeExactPackageSpec(value, label) {
	const { spec } = parseExactPackageSpec(value, label);
	return spec;
}

function normalizeGlobList(value, label) {
	if (value === undefined) {
		return [];
	}

	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array`);
	}

	return value.map((entry, index) =>
		normalizeGlobPattern(entry, `${label}[${index}]`),
	);
}

function normalizeGlobPattern(value, label = "glob pattern") {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}

	const normalized = normalizeRelativePath(value.trim());
	return normalized.endsWith("/") ? `${normalized}**` : normalized;
}

function normalizeRelativePath(value) {
	return String(value).replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function getExcludedPatterns(config, linterName) {
	const normalized = normalizeLoadedConfig(config);
	const linterConfig = getLinterConfig(normalized, linterName);

	return [...normalized.global.exclude_paths, ...linterConfig.exclude_paths];
}

function getLinterConfig(config, linterName) {
	const normalized = normalizeLoadedConfig(config);
	const linterConfig = normalized.linters[linterName];

	return (
		linterConfig || {
			disabled: false,
			disabled_explicit: false,
			exclude_paths: [],
			preset_packages: [],
		}
	);
}

function getTextlintPresetPackages(config) {
	return [...getLinterConfig(config, "textlint").preset_packages];
}

function isLinterEnabled(config, linterName, { defaultDisabled = false } = {}) {
	const normalized = normalizeLoadedConfig(config);
	const linterConfig = normalized.linters[linterName];

	if (!linterConfig) {
		return defaultDisabled !== true;
	}

	if (linterConfig.disabled === true) {
		return false;
	}

	if (defaultDisabled) {
		return linterConfig.disabled_explicit === true;
	}

	return true;
}

function isPathExcluded(config, linterName, candidatePath) {
	const normalizedPath = normalizeRelativePath(candidatePath);
	return getExcludedPatterns(config, linterName).some((pattern) =>
		matchesExcludedPattern(normalizedPath, pattern),
	);
}

function filterExcludedPaths(config, linterName, candidatePaths) {
	return candidatePaths.filter(
		(candidatePath) => !isPathExcluded(config, linterName, candidatePath),
	);
}

function normalizeLoadedConfig(config) {
	if (
		!config ||
		typeof config !== "object" ||
		!config.global ||
		typeof config.global !== "object" ||
		!config.linters ||
		typeof config.linters !== "object"
	) {
		throw new Error(
			"loaded linter-service config must include global and linters",
		);
	}

	return config;
}

function matchesExcludedPattern(candidatePath, pattern) {
	if (path.posix.matchesGlob(candidatePath, pattern)) {
		return true;
	}

	if (!pattern.endsWith("/**")) {
		return false;
	}

	const directoryPattern = pattern.slice(0, -3);
	let currentDirectory = path.posix.dirname(candidatePath);

	while (currentDirectory !== "." && currentDirectory.length > 0) {
		if (path.posix.matchesGlob(currentDirectory, directoryPattern)) {
			return true;
		}

		const parentDirectory = path.posix.dirname(currentDirectory);

		if (parentDirectory === currentDirectory) {
			break;
		}

		currentDirectory = parentDirectory;
	}

	return false;
}

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} is required`);
	}

	return value;
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	filterExcludedPaths,
	getLinterConfig,
	getExcludedPatterns,
	getTextlintPresetPackages,
	isLinterEnabled,
	isPathExcluded,
	loadLinterServiceConfig,
	normalizeGlobPattern,
	normalizeLinterServiceConfig,
	normalizeRelativePath,
	runFromEnv,
};
