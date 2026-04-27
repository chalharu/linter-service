const path = require("node:path");

const TOOL_URI = "https://github.com/chalharu/linter-service";

function buildSarifEnvelope({
	category,
	results,
	rules,
	runMetadata,
	toolName,
}) {
	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				...(runMetadata && typeof runMetadata === "object"
					? structuredClone(runMetadata)
					: {}),
				automationDetails: {
					id: category,
				},
				results,
				tool: {
					driver: {
						informationUri: TOOL_URI,
						name: toolName,
						rules,
					},
				},
			},
		],
	};
}

function readEmbeddedSarif(result) {
	const sarif = result?.sarif;
	return sarif && typeof sarif === "object" && Array.isArray(sarif.runs)
		? sarif
		: null;
}

function readSarifRun(sarif) {
	return Array.isArray(sarif?.runs) ? sarif.runs[0] || null : null;
}

function buildDetailsTextFromSarif({ sarif, sourceRepositoryPath }) {
	const run = readSarifRun(sarif);
	if (!run || !Array.isArray(run.results)) {
		return "";
	}

	const seen = new Set();
	const lines = [];

	for (const result of run.results) {
		const line = formatSarifResultForDetails({ result, sourceRepositoryPath });
		if (!line || seen.has(line)) {
			continue;
		}

		seen.add(line);
		lines.push(line);
	}

	return lines.join("\n");
}

function formatSarifResultForDetails({ result, sourceRepositoryPath }) {
	const locationPrefix = formatSarifLocationPrefix({
		location: result?.locations?.[0],
		sourceRepositoryPath,
	});
	const ruleId =
		typeof result?.ruleId === "string" && result.ruleId.length > 0
			? result.ruleId
			: "";
	const message = extractSarifMessageText(result?.message);
	const parts = [locationPrefix, ruleId, message].filter(Boolean);

	return parts.join(" ");
}

function formatSarifLocationPrefix({ location, sourceRepositoryPath }) {
	const uri = normalizeSarifDisplayPath(
		location?.physicalLocation?.artifactLocation?.uri,
		sourceRepositoryPath,
	);
	if (!uri) {
		return "";
	}

	const region = location?.physicalLocation?.region;
	const startLine =
		Number.isInteger(region?.startLine) && region.startLine > 0
			? String(region.startLine)
			: "";
	const startColumn =
		Number.isInteger(region?.startColumn) && region.startColumn > 0
			? String(region.startColumn)
			: "";

	return [uri, startLine, startColumn].filter(Boolean).join(":");
}

function normalizeSarifDisplayPath(uri, sourceRepositoryPath) {
	if (typeof uri !== "string" || uri.length === 0) {
		return "";
	}

	const normalizedUri = uri.startsWith("file://") ? uri.slice(7) : uri;
	const repoRoot =
		typeof sourceRepositoryPath === "string" && sourceRepositoryPath.length > 0
			? path.resolve(sourceRepositoryPath)
			: "";

	if (repoRoot.length > 0 && path.isAbsolute(normalizedUri)) {
		const relativePath = path.relative(repoRoot, normalizedUri);
		if (
			relativePath === "" ||
			(!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
		) {
			return normalizeSarifPath(relativePath || path.basename(normalizedUri));
		}
	}

	return normalizeSarifPath(normalizedUri);
}

function extractSarifMessageText(message) {
	if (!message || typeof message !== "object") {
		return "";
	}

	if (typeof message.text === "string" && message.text.length > 0) {
		return message.text.trim();
	}

	if (typeof message.markdown === "string" && message.markdown.length > 0) {
		return message.markdown.trim();
	}

	return "";
}

function normalizeSarifPath(filePath) {
	return String(filePath || "").replace(/\\/gu, "/");
}

module.exports = {
	buildDetailsTextFromSarif,
	buildSarifEnvelope,
	extractSarifMessageText,
	readEmbeddedSarif,
	readSarifRun,
	TOOL_URI,
};
