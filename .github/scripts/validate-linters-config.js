const fs = require("node:fs");
const path = require("node:path");

const { validateDataAgainstSchema } = require("./lib/schema-validator.js");

function skipWhitespace(text, index) {
	while (index < text.length && /\s/u.test(text[index])) {
		index += 1;
	}
	return index;
}

function parseStringToken(text, startIndex) {
	let index = startIndex + 1;
	while (index < text.length) {
		if (text[index] === "\\") {
			index += 2;
			continue;
		}
		if (text[index] === '"') {
			return {
				nextIndex: index + 1,
				value: JSON.parse(text.slice(startIndex, index + 1)),
			};
		}
		index += 1;
	}

	throw new Error("unterminated JSON string");
}

function parseNumberToken(text, startIndex) {
	const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
		text.slice(startIndex),
	);
	if (!match) {
		throw new Error(`invalid JSON number at offset ${startIndex}`);
	}
	return startIndex + match[0].length;
}

function formatJsonPointer(pathSegments) {
	return pathSegments.length === 0
		? "/"
		: `/${pathSegments
				.map((segment) =>
					String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
				)
				.join("/")}`;
}

function parseJsonValue(text, startIndex, pathSegments, duplicatePaths) {
	const index = skipWhitespace(text, startIndex);
	const nextPathDepth = pathSegments.length;
	if (index >= text.length) {
		throw new Error("unexpected end of JSON input");
	}

	switch (text[index]) {
		case "{":
			return parseJsonObject(text, index, pathSegments, duplicatePaths);
		case "[":
			return parseJsonArray(text, index, pathSegments, duplicatePaths);
		case '"':
			return parseStringToken(text, index).nextIndex;
		case "t":
			if (text.startsWith("true", index)) {
				return index + 4;
			}
			break;
		case "f":
			if (text.startsWith("false", index)) {
				return index + 5;
			}
			break;
		case "n":
			if (text.startsWith("null", index)) {
				return index + 4;
			}
			break;
		default:
			if (text[index] === "-" || /\d/u.test(text[index])) {
				return parseNumberToken(text, index);
			}
	}

	throw new Error(
		`unsupported JSON token at offset ${index} (path depth ${nextPathDepth})`,
	);
}

function parseJsonObject(text, startIndex, pathSegments, duplicatePaths) {
	let index = skipWhitespace(text, startIndex + 1);
	const seenKeys = new Set();

	if (text[index] === "}") {
		return index + 1;
	}

	while (index < text.length) {
		if (text[index] !== '"') {
			throw new Error(`expected object key at offset ${index}`);
		}

		const { nextIndex, value: key } = parseStringToken(text, index);
		if (seenKeys.has(key)) {
			duplicatePaths.add(formatJsonPointer([...pathSegments, key]));
		}
		seenKeys.add(key);

		index = skipWhitespace(text, nextIndex);
		if (text[index] !== ":") {
			throw new Error(`expected ":" after ${JSON.stringify(key)}`);
		}

		index = parseJsonValue(
			text,
			index + 1,
			[...pathSegments, key],
			duplicatePaths,
		);
		index = skipWhitespace(text, index);

		if (text[index] === "}") {
			return index + 1;
		}
		if (text[index] !== ",") {
			throw new Error(`expected "," or "}" at offset ${index}`);
		}
		index = skipWhitespace(text, index + 1);
	}

	throw new Error("unterminated JSON object");
}

function parseJsonArray(text, startIndex, pathSegments, duplicatePaths) {
	let index = skipWhitespace(text, startIndex + 1);
	if (text[index] === "]") {
		return index + 1;
	}

	while (index < text.length) {
		index = parseJsonValue(text, index, pathSegments, duplicatePaths);
		index = skipWhitespace(text, index);
		if (text[index] === "]") {
			return index + 1;
		}
		if (text[index] !== ",") {
			throw new Error(`expected "," or "]" at offset ${index}`);
		}
		index = skipWhitespace(text, index + 1);
	}

	throw new Error("unterminated JSON array");
}

function assertUniqueLinterObjectKeys(configSource) {
	const duplicatePaths = new Set();
	const index = parseJsonValue(
		configSource,
		skipWhitespace(configSource, 0),
		[],
		duplicatePaths,
	);
	if (skipWhitespace(configSource, index) !== configSource.length) {
		throw new Error("unexpected trailing content in linters.json");
	}
	if (duplicatePaths.size === 0) {
		return;
	}

	const suffix = duplicatePaths.size === 1 ? "key" : "keys";
	throw new Error(
		`linters config contains duplicate object ${suffix}: ${Array.from(
			duplicatePaths,
		)
			.sort()
			.map((pointer) => JSON.stringify(pointer))
			.join(", ")}`,
	);
}

function validateLintersConfig({
	configPath = path.join(__dirname, "..", "..", "linters.json"),
	schemaPath = path.join(__dirname, "..", "..", "linters.schema.json"),
} = {}) {
	const configSource = fs.readFileSync(configPath, "utf8");
	const config = JSON.parse(configSource);
	assertUniqueLinterObjectKeys(configSource);
	const { schema } = validateDataAgainstSchema({
		data: config,
		label: "linters config",
		schemaPath,
	});
	return { config, configPath, schema, schemaPath };
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
