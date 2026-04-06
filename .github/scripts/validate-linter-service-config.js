const fs = require("node:fs");
const path = require("node:path");

const {
	normalizeLinterServiceConfig,
	parseLinterServiceConfigSource,
} = require("./linter-service-config.js");
const { validateDataAgainstSchema } = require("./lib/schema-validator.js");

function validateLinterServiceConfig({
	configPath = path.join(__dirname, "..", "linter-service.yaml"),
	schemaPath = path.join(__dirname, "..", "linter-service.schema.json"),
} = {}) {
	const source = fs.readFileSync(configPath, "utf8");
	const config = parseLinterServiceConfigSource({
		configPath,
		source,
	});
	const { schema } = validateDataAgainstSchema({
		data: config,
		label: "linter-service config",
		schemaPath,
	});
	const normalizedConfig = normalizeLinterServiceConfig(config);

	return {
		config,
		configPath,
		normalizedConfig,
		schema,
		schemaPath,
	};
}

function runFromCli() {
	const report = validateLinterServiceConfig();
	process.stdout.write(
		`${path.basename(report.configPath)} matches ${path.basename(report.schemaPath)}.\n`,
	);
	return report;
}

if (require.main === module) {
	runFromCli();
}

module.exports = {
	runFromCli,
	validateLinterServiceConfig,
};
