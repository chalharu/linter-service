const fs = require("node:fs");
const path = require("node:path");

function runFromEnv(env = process.env) {
	const report = prepareDeselectedSarif({
		configPath: requireEnv(env, "LINTER_CONFIG_PATH"),
		outputRoot: requireEnv(env, "OUTPUT_ROOT"),
		selectedLintersJson: env.SELECTED_LINTERS_JSON || "[]",
	});

	if (typeof env.GITHUB_OUTPUT === "string" && env.GITHUB_OUTPUT.length > 0) {
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			`prepared=${String(report.prepared)}\n`,
			"utf8",
		);
	}

	return report;
}

function prepareDeselectedSarif({
	configPath,
	outputRoot,
	selectedLintersJson,
}) {
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const linters = Array.isArray(config.linters) ? config.linters : [];
	const selectedLinters = new Set(parseSelectedLinters(selectedLintersJson));

	fs.mkdirSync(outputRoot, { recursive: true });

	let prepared = 0;

	for (const linter of linters) {
		if (
			!linter ||
			typeof linter.name !== "string" ||
			!linter.sarif ||
			linter.sarif.enabled !== true ||
			selectedLinters.has(linter.name)
		) {
			continue;
		}

		const outputPath = path.join(outputRoot, `empty-${linter.name}.sarif`);
		fs.writeFileSync(
			outputPath,
			JSON.stringify(buildEmptySarif(linter), null, 2),
			"utf8",
		);
		prepared += 1;
	}

	return { outputRoot, prepared };
}

function parseSelectedLinters(selectedLintersJson) {
	const parsed = JSON.parse(selectedLintersJson);

	if (!Array.isArray(parsed)) {
		throw new Error("SELECTED_LINTERS_JSON must decode to an array");
	}

	for (const entry of parsed) {
		if (typeof entry !== "string") {
			throw new Error("SELECTED_LINTERS_JSON entries must be strings");
		}
	}

	return parsed;
}

function buildEmptySarif(linter) {
	const category = linter.sarif.category || `linter-service/${linter.name}`;
	const toolName = linter.sarif.tool_name || `linter-service/${linter.name}`;

	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				automationDetails: {
					id: category,
				},
				results: [],
				tool: {
					driver: {
						informationUri: "https://github.com/chalharu/linter-service",
						name: toolName,
						rules: [],
					},
				},
			},
		],
	};
}

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

if (require.main === module) {
	runFromEnv();
}

module.exports = prepareDeselectedSarif;
module.exports.buildEmptySarif = buildEmptySarif;
module.exports.runFromEnv = runFromEnv;
