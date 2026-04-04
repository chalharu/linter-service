const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
	loadLinterServiceConfig,
	normalizeRelativePath,
} = require("./linter-service-config.js");
const { readPatterns, selectFiles } = require("./linter-targeting.js");

function runFromEnv(env = process.env) {
	const contextPath = requireEnv(env, "CONTEXT_PATH");
	const linterName = requireEnv(env, "LINTER_NAME");
	const outputPath = requireEnv(env, "OUTPUT_PATH");
	const patternPath = requireEnv(env, "PATTERN_PATH");
	const repositoryPath = requireEnv(env, "SOURCE_REPOSITORY_PATH");
	const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
	const patterns = readPatterns(patternPath);
	const serviceConfig = loadLinterServiceConfig({
		repositoryPath,
	});
	const configTriggerPatterns = readConfigTriggerPatterns({
		configPath: env.LINTER_CONFIG_PATH,
		linterName,
	});
	const changedFiles = readChangedFiles(context);
	const candidatePaths = hasConfigTriggerMatch({
		changedFiles,
		configTriggerPatterns,
		linterName,
		serviceConfig,
	})
		? listRepositoryFiles(repositoryPath)
		: changedFiles;
	const selectedFiles = selectFiles({
		candidatePaths,
		linterName,
		patterns,
		serviceConfig,
	});

	fs.writeFileSync(
		outputPath,
		selectedFiles.length > 0 ? `${selectedFiles.join("\n")}\n` : "",
		"utf8",
	);

	if (typeof env.GITHUB_OUTPUT === "string" && env.GITHUB_OUTPUT.length > 0) {
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			`count=${selectedFiles.length}\n`,
			"utf8",
		);
	}

	return {
		outputPath,
		selectedFiles,
	};
}

function readChangedFiles(context) {
	if (
		!context ||
		typeof context !== "object" ||
		!Array.isArray(context.changed_files)
	) {
		throw new Error("context must include changed_files");
	}

	return context.changed_files;
}

function readConfigTriggerPatterns({ configPath, linterName }) {
	if (
		typeof configPath !== "string" ||
		configPath.length === 0 ||
		!fs.existsSync(configPath)
	) {
		return [];
	}

	const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));

	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.linters)) {
		throw new Error("linters.json must include a linters array");
	}

	const definition = parsed.linters.find(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			!Array.isArray(entry) &&
			entry.name === linterName,
	);

	if (
		!definition ||
		typeof definition.config_trigger_patterns === "undefined"
	) {
		return [];
	}

	if (
		!Array.isArray(definition.config_trigger_patterns) ||
		definition.config_trigger_patterns.some(
			(pattern) => typeof pattern !== "string" || pattern.trim().length === 0,
		)
	) {
		throw new Error(
			`${linterName}.config_trigger_patterns must be an array of non-empty strings`,
		);
	}

	return definition.config_trigger_patterns;
}

function hasConfigTriggerMatch({
	changedFiles,
	configTriggerPatterns,
	linterName,
	serviceConfig,
}) {
	if (
		!Array.isArray(configTriggerPatterns) ||
		configTriggerPatterns.length === 0
	) {
		return false;
	}

	return (
		selectFiles({
			candidatePaths: changedFiles,
			linterName,
			patterns: configTriggerPatterns,
			serviceConfig,
		}).length > 0
	);
}

function listRepositoryFiles(repositoryPath) {
	if (fs.existsSync(path.join(repositoryPath, ".git"))) {
		return execFileSync("git", ["ls-files"], {
			cwd: repositoryPath,
			encoding: "utf8",
		})
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(normalizeRelativePath);
	}

	const resolvedRepositoryPath = path.resolve(repositoryPath);
	const files = [];

	walkRepository(resolvedRepositoryPath);

	return files.sort();

	function walkRepository(currentPath) {
		for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
			if (entry.name === ".git") {
				continue;
			}

			const entryPath = path.join(currentPath, entry.name);
			const symlinkTarget =
				entry.isSymbolicLink() && fs.existsSync(entryPath)
					? fs.statSync(entryPath)
					: null;

			if (entry.isDirectory()) {
				walkRepository(entryPath);
				continue;
			}

			if (entry.isFile() || symlinkTarget?.isFile()) {
				files.push(
					normalizeRelativePath(
						path.relative(resolvedRepositoryPath, entryPath),
					),
				);
			}
		}
	}
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
	listRepositoryFiles,
	readChangedFiles,
	readConfigTriggerPatterns,
	runFromEnv,
};
