const path = require("node:path");

const { readNativeSarifRun } = require("./render-linter-sarif.js");

function buildDetails({ linterName, runnerTemp, sourceRepositoryPath }) {
	if (linterName !== "biome") {
		return undefined;
	}

	const run = readNativeSarifRun(runnerTemp);
	if (!run || !Array.isArray(run.results)) {
		return "";
	}

	const seen = new Set();
	const lines = [];

	for (const result of run.results) {
		const line = formatResult({ result, sourceRepositoryPath });
		if (!line || seen.has(line)) {
			continue;
		}

		seen.add(line);
		lines.push(line);
	}

	return lines.join("\n");
}

function formatResult({ result, sourceRepositoryPath }) {
	const locationPrefix = formatLocationPrefix({
		location: result?.locations?.[0],
		sourceRepositoryPath,
	});
	const ruleId =
		typeof result?.ruleId === "string" && result.ruleId.length > 0
			? result.ruleId
			: "";
	const message = extractMessageText(result?.message);
	const parts = [locationPrefix, ruleId, message].filter(Boolean);

	return parts.join(" ");
}

function formatLocationPrefix({ location, sourceRepositoryPath }) {
	const uri = normalizeDisplayPath(
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

function normalizeDisplayPath(uri, sourceRepositoryPath) {
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
			return normalizePath(relativePath || path.basename(normalizedUri));
		}
	}

	return normalizePath(normalizedUri);
}

function extractMessageText(message) {
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

function normalizePath(filePath) {
	return filePath.replace(/\\/gu, "/");
}

module.exports = {
	buildDetails,
};
