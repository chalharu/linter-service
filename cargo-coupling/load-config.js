const path = require("node:path");

const {
	getLinterConfig,
	loadLinterServiceConfig,
} = require("../.github/scripts/linter-service-config.js");
const { normalizeCargoCouplingConfig } = require("./cargo-coupling-config.js");

function loadCargoCouplingConfig(repositoryPath) {
	const serviceConfig = loadLinterServiceConfig({ repositoryPath });
	return normalizeCargoCouplingConfig({
		currentConfig: getLinterConfig(serviceConfig, "cargo-coupling"),
	});
}

if (require.main === module) {
	const repositoryPath =
		process.argv[2] && process.argv[2].length > 0
			? path.resolve(process.argv[2])
			: process.cwd();
	process.stdout.write(
		`${JSON.stringify(loadCargoCouplingConfig(repositoryPath))}\n`,
	);
}

module.exports = {
	loadCargoCouplingConfig,
};
