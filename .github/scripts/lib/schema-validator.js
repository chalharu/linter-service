const fs = require("node:fs");
const path = require("node:path");

const Ajv2020 = require("ajv/dist/2020").default;

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function validateDataAgainstSchema({ data, label, schemaPath }) {
	const ajv = new Ajv2020({ allErrors: true });
	const schema = readJson(schemaPath);
	const validate = ajv.compile(schema);

	if (validate(data)) {
		return { schema, schemaPath };
	}

	const message =
		Array.isArray(validate.errors) && validate.errors.length > 0
			? validate.errors.map(formatValidationError).join("\n")
			: "schema validation failed";
	const error = new Error(
		`${label} does not match ${path.basename(schemaPath)}:\n${message}`,
	);
	error.errors = validate.errors;
	throw error;
}

module.exports = {
	formatValidationError,
	readJson,
	validateDataAgainstSchema,
};
