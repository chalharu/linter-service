const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const requireEnv = require("./lib/require-env.js");

const TOOL_NAME = "linter-service";
const TOOL_URI = "https://github.com/chalharu/linter-service";
const MAX_RUNS_PER_FILE = 20;

function runFromEnv(env = process.env) {
	return aggregateSarif({
		inputRoot: requireEnv(env, "SARIF_INPUT_ROOT"),
		outputPath: requireEnv(env, "SARIF_OUTPUT_PATH"),
	});
}

function aggregateSarif({ inputRoot, outputPath }) {
	const fileNames = fs.existsSync(inputRoot)
		? fs
				.readdirSync(inputRoot)
				.filter((fileName) => fileName.endsWith(".sarif"))
				.sort()
		: [];
	const runs = [];

	for (const fileName of fileNames) {
		const sarifPath = path.join(inputRoot, fileName);
		const sarif = JSON.parse(fs.readFileSync(sarifPath, "utf8"));
		const fileRuns = Array.isArray(sarif?.runs) ? sarif.runs : [];

		for (const run of fileRuns) {
			runs.push(
				normalizeRun({
					fileName,
					run,
				}),
			);
		}
	}

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	writeSarifOutputs({ outputPath, runs });

	return {
		fileCount: fileNames.length,
		outputPath,
		runCount: runs.length,
	};
}

function writeSarifOutputs({ outputPath, runs }) {
	const chunks = chunkRuns(runs, MAX_RUNS_PER_FILE);

	for (const [index, chunk] of chunks.entries()) {
		const chunkOutputPath =
			chunks.length === 1
				? outputPath
				: buildChunkOutputPath(outputPath, index + 1, chunks.length);

		fs.writeFileSync(
			chunkOutputPath,
			JSON.stringify(
				{
					$schema: "https://json.schemastore.org/sarif-2.1.0.json",
					version: "2.1.0",
					runs: chunk,
				},
				null,
				2,
			),
			"utf8",
		);
	}
}

function chunkRuns(runs, chunkSize) {
	if (!Array.isArray(runs) || runs.length === 0) {
		return [[]];
	}

	const chunks = [];

	for (let index = 0; index < runs.length; index += chunkSize) {
		chunks.push(runs.slice(index, index + chunkSize));
	}

	return chunks;
}

function buildChunkOutputPath(outputPath, chunkIndex, chunkCount) {
	const directory = path.dirname(outputPath);
	const extension = path.extname(outputPath);
	const baseName = path.basename(outputPath, extension);
	const width = String(chunkCount).length;
	const suffix = String(chunkIndex).padStart(width, "0");

	return path.join(directory, `${baseName}-${suffix}${extension}`);
}

function normalizeRun({ fileName, run }) {
	const linterName = deriveLinterName({ fileName, run });
	const driver =
		run?.tool?.driver && typeof run.tool.driver === "object"
			? run.tool.driver
			: {};

	return {
		...run,
		automationDetails: {
			...(run?.automationDetails && typeof run.automationDetails === "object"
				? run.automationDetails
				: {}),
			id:
				typeof run?.automationDetails?.id === "string" &&
				run.automationDetails.id.length > 0
					? run.automationDetails.id
					: `${TOOL_NAME}/${linterName}`,
		},
		properties: {
			...(run?.properties && typeof run.properties === "object"
				? run.properties
				: {}),
			linter_name: linterName,
		},
		results: normalizeResults(run?.results, linterName),
		tool: {
			...(run?.tool && typeof run.tool === "object" ? run.tool : {}),
			driver: {
				...driver,
				informationUri:
					typeof driver.informationUri === "string" &&
					driver.informationUri.length > 0
						? driver.informationUri
						: TOOL_URI,
				name: TOOL_NAME,
				rules: normalizeRules(driver.rules, linterName),
			},
		},
	};
}

function normalizeResults(results, linterName) {
	if (!Array.isArray(results)) {
		return [];
	}

	return results.map((result) => {
		const originalRuleId =
			typeof result?.ruleId === "string" && result.ruleId.length > 0
				? result.ruleId
				: `${linterName}/diagnostic`;
		const prefixedRuleId = prefixRuleId(originalRuleId, linterName);
		const originalMessage =
			typeof result?.message?.text === "string" &&
			result.message.text.length > 0
				? result.message.text
				: "Issue reported by linter-service.";
		const messageText = prefixMessage(originalMessage, linterName);

		return {
			...result,
			message: {
				...(result?.message && typeof result.message === "object"
					? result.message
					: {}),
				text: messageText,
			},
			partialFingerprints: normalizePartialFingerprints(
				result?.partialFingerprints,
				linterName,
			),
			properties: {
				...(result?.properties && typeof result.properties === "object"
					? result.properties
					: {}),
				linter_name: linterName,
				original_rule_id: originalRuleId,
			},
			ruleId: prefixedRuleId,
		};
	});
}

function normalizeRules(rules, linterName) {
	if (!Array.isArray(rules)) {
		return [];
	}

	return rules.map((rule) => {
		const originalRuleId =
			typeof rule?.id === "string" && rule.id.length > 0
				? rule.id
				: `${linterName}/diagnostic`;
		const prefixedRuleId = prefixRuleId(originalRuleId, linterName);
		const shortDescriptionText =
			typeof rule?.shortDescription?.text === "string" &&
			rule.shortDescription.text.length > 0
				? rule.shortDescription.text
				: originalRuleId;

		return {
			...rule,
			id: prefixedRuleId,
			name:
				typeof rule?.name === "string" && rule.name.length > 0
					? prefixRuleId(rule.name, linterName)
					: prefixedRuleId,
			properties: {
				...(rule?.properties && typeof rule.properties === "object"
					? rule.properties
					: {}),
				linter_name: linterName,
				original_rule_id: originalRuleId,
			},
			shortDescription: {
				...(rule?.shortDescription && typeof rule.shortDescription === "object"
					? rule.shortDescription
					: {}),
				text: prefixMessage(shortDescriptionText, linterName),
			},
		};
	});
}

function normalizePartialFingerprints(partialFingerprints, linterName) {
	if (!partialFingerprints || typeof partialFingerprints !== "object") {
		return partialFingerprints;
	}

	return Object.fromEntries(
		Object.entries(partialFingerprints).map(([key, value]) => [
			key,
			hashValue(`${linterName}|${String(value)}`),
		]),
	);
}

function deriveLinterName({ fileName, run }) {
	const fromFileName = /^(?:empty-|linter-sarif-)(?<name>.+)\.sarif$/u.exec(
		fileName,
	);
	if (fromFileName?.groups?.name) {
		return fromFileName.groups.name;
	}

	const automationId =
		typeof run?.automationDetails?.id === "string"
			? run.automationDetails.id
			: "";
	if (automationId.includes("/")) {
		return automationId.split("/").pop();
	}

	const driverName =
		typeof run?.tool?.driver?.name === "string" ? run.tool.driver.name : "";
	if (driverName.includes("/")) {
		return driverName.split("/").pop();
	}

	return "unknown";
}

function prefixRuleId(ruleId, linterName) {
	const normalizedRuleId = String(ruleId || "").trim();

	if (normalizedRuleId.startsWith(`${linterName}/`)) {
		return normalizedRuleId;
	}

	return `${linterName}/${normalizedRuleId || "diagnostic"}`;
}

function prefixMessage(messageText, linterName) {
	const normalizedMessage = String(messageText || "").trim();
	const prefix = `[${linterName}] `;

	if (normalizedMessage.startsWith(prefix)) {
		return normalizedMessage;
	}

	return `${prefix}${normalizedMessage || "Issue reported by linter-service."}`;
}

function hashValue(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	aggregateSarif,
	buildChunkOutputPath,
	chunkRuns,
	deriveLinterName,
	normalizePartialFingerprints,
	normalizeRun,
	prefixMessage,
	prefixRuleId,
	runFromEnv,
};
