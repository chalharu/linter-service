const fs = require("node:fs");

const { loadLinterServiceConfig } = require("./linter-service-config.js");
const { readPatterns, selectFiles } = require("./linter-targeting.js");

function runFromEnv(env = process.env) {
	const contextPath = requireEnv(env, "CONTEXT_PATH");
	const linterName = requireEnv(env, "LINTER_NAME");
	const outputPath = requireEnv(env, "OUTPUT_PATH");
	const patternPath = requireEnv(env, "PATTERN_PATH");
	const repositoryPath = requireEnv(env, "SOURCE_REPOSITORY_PATH");
	const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
	const candidatePaths = readChangedFiles(context);
	const patterns = readPatterns(patternPath);
	const serviceConfig = loadLinterServiceConfig({
		repositoryPath,
	});
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
	readChangedFiles,
	runFromEnv,
};
