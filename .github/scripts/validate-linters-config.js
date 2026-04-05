const path = require("node:path");

const {
	readJson,
	validateDataAgainstSchema,
} = require("./lib/schema-validator.js");

function validateLintersConfig({
	configPath = path.join(__dirname, "..", "..", "linters.json"),
	schemaPath = path.join(__dirname, "..", "..", "linters.schema.json"),
} = {}) {
	const config = readJson(configPath);
	const { schema } = validateDataAgainstSchema({
		data: config,
		label: "linters config",
		schemaPath,
	});
	validateUniqueLinterNames(config);
	return { config, configPath, schema, schemaPath };
}

function validateUniqueLinterNames(config) {
	const seenNames = new Set();

	for (const [index, linter] of config.linters.entries()) {
		const name = linter.name;

		if (seenNames.has(name)) {
			throw new Error(
				`linters config includes duplicate linter name at /linters/${index}/name: ${JSON.stringify(name)}`,
			);
		}

		seenNames.add(name);
	}
}

function runFromCli() {
	const report = validateLintersConfig();
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
	validateLintersConfig,
};
