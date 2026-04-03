const fs = require("node:fs");
const path = require("node:path");

function runFromEnv(env = process.env) {
	const repositoryPath = requireEnv(env, "SOURCE_REPOSITORY_PATH");
	return loadLinterServiceConfig({ repositoryPath });
}

function loadLinterServiceConfig({ configPath, repositoryPath } = {}) {
	const resolvedPath =
		typeof configPath === "string" && configPath.length > 0
			? configPath
			: path.join(
					requireString(repositoryPath, "repositoryPath"),
					".github",
					"linter-service.json",
				);

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

	const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
	const normalized = normalizeLinterServiceConfig(parsed);
	return {
		configPath: resolvedPath,
		exists: true,
		...normalized,
	};
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

		entries[linterName] = {
			disabled: currentConfig.disabled === true,
			exclude_paths: normalizeGlobList(
				currentConfig.exclude_paths,
				`linters.${linterName}.exclude_paths`,
			),
		};
	}

	return entries;
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
	const linterConfig = normalized.linters[linterName] || {
		disabled: false,
		exclude_paths: [],
	};

	return [...normalized.global.exclude_paths, ...linterConfig.exclude_paths];
}

function isLinterEnabled(config, linterName) {
	const normalized = normalizeLoadedConfig(config);
	return normalized.linters[linterName]?.disabled !== true;
}

function isPathExcluded(config, linterName, candidatePath) {
	const normalizedPath = normalizeRelativePath(candidatePath);
	return getExcludedPatterns(config, linterName).some((pattern) =>
		path.posix.matchesGlob(normalizedPath, pattern),
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

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} is required`);
	}

	return value;
}

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	filterExcludedPaths,
	getExcludedPatterns,
	isLinterEnabled,
	isPathExcluded,
	loadLinterServiceConfig,
	normalizeGlobPattern,
	normalizeLinterServiceConfig,
	normalizeRelativePath,
	runFromEnv,
};
