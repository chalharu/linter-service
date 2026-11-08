const path = require("node:path");

const {
	loadLinterServiceConfig,
	getLinterConfig,
} = require("../.github/scripts/linter-service-config.js");
const {
	normalizeCargoClippyConfig,
} = require("./cargo-clippy-config.js");

function loadConfig(repositoryPath) {
	const resolvedPath =
		typeof repositoryPath === "string" && repositoryPath.length > 0
			? path.resolve(repositoryPath)
			: process.cwd();

	const serviceConfig = loadLinterServiceConfig({
		repositoryPath: resolvedPath,
	});
	const linterConfig = getLinterConfig(serviceConfig, "cargo-clippy");

	return normalizeCargoClippyConfig({
		currentConfig: linterConfig,
		label: "linters.cargo-clippy",
	});
}

if (require.main === module) {
	const [repositoryPath] = process.argv.slice(2);
	process.stdout.write(`${JSON.stringify(loadConfig(repositoryPath))}\n`);
}

module.exports = { loadConfig };
