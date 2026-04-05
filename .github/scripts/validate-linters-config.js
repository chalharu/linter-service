const fs = require("node:fs");
const path = require("node:path");

const Ajv2020 = require("ajv/dist/2020").default;

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateLintersConfig({
	configPath = path.join(__dirname, "..", "..", "linters.json"),
	schemaPath = path.join(__dirname, "..", "..", "linters.schema.json"),
} = {}) {
	const ajv = new Ajv2020({ allErrors: true });
	const schema = readJson(schemaPath);
	const config = readJson(configPath);
	const validate = ajv.compile(schema);

	if (validate(config)) {
		validateUniqueLinterNames(config);
		return { config, configPath, schema, schemaPath };
	}

	const message = validate.errors.map(formatValidationError).join("\n");
	const error = new Error(
		`linters config does not match ${path.basename(schemaPath)}:\n${message}`,
	);
	error.errors = validate.errors;
	throw error;
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

function formatValidationError(error) {
	const instancePath =
		typeof error.instancePath === "string" && error.instancePath.length > 0
			? error.instancePath
			: "<root>";
	if (
		error.keyword === "additionalProperties" &&
		error.params &&
		typeof error.params.additionalProperty === "string"
	) {
		return `${instancePath}: unexpected property ${JSON.stringify(error.params.additionalProperty)}`;
	}

	return `${instancePath}: ${error.message}`;
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
	formatValidationError,
	runFromCli,
	validateLintersConfig,
};
