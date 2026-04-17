const fs = require("node:fs");
const path = require("node:path");

function readCargoClippyRuns({ result, runnerTemp }) {
	if (Array.isArray(result?.cargo_clippy_runs)) {
		return result.cargo_clippy_runs;
	}

	if (typeof runnerTemp !== "string" || runnerTemp.length === 0) {
		return [];
	}

	const sidecarPath = path.join(
		runnerTemp,
		"cargo-clippy-structured-runs.json",
	);

	if (!fs.existsSync(sidecarPath)) {
		return [];
	}

	return JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
}

function buildSarifResults({
	createResult,
	dedupeResults,
	defaultLevel,
	linterName,
	normalizeReportedPath,
	parseInteger,
	reportedPathRoots,
	result,
	runnerTemp,
	sourceRepositoryPath,
	targetPaths,
	toSarifLevel,
}) {
	if (linterName !== "cargo-clippy") {
		return [];
	}

	const clippyRuns = readCargoClippyRuns({ result, runnerTemp });
	const results = [];

	for (const run of clippyRuns) {
		for (const diagnostic of [
			...(Array.isArray(run?.diagnostics) ? run.diagnostics : []),
			...(Array.isArray(run?.warning_diagnostics)
				? run.warning_diagnostics
				: []),
		]) {
			const message =
				diagnostic?.message && typeof diagnostic.message === "object"
					? diagnostic.message
					: {};
			const span = resolveCargoClippyPrimarySpan(message);
			const filePath = span?.file_name
				? normalizeReportedPath(
						sourceRepositoryPath,
						span.file_name,
						targetPaths,
						reportedPathRoots,
					)
				: null;

			results.push(
				createResult({
					column: parseInteger(span?.column_start),
					defaultLevel: toSarifLevel(message.level || "", defaultLevel),
					filePath,
					line: parseInteger(span?.line_start),
					linterName,
					message: resolveCargoClippyMessage(message),
					ruleId: resolveCargoClippyRuleId(message, linterName),
				}),
			);
		}
	}

	return dedupeResults(results);
}

function resolveCargoClippyPrimarySpan(message) {
	const spans = Array.isArray(message?.spans) ? message.spans : [];

	return (
		spans.find(
			(span) => span?.is_primary && typeof span.file_name === "string",
		) ||
		spans.find((span) => typeof span?.file_name === "string") ||
		null
	);
}

function resolveCargoClippyMessage(message) {
	return typeof message?.message === "string" && message.message.length > 0
		? message.message
		: "cargo-clippy reported an issue";
}

function resolveCargoClippyRuleId(message, linterName) {
	return typeof message?.code?.code === "string" && message.code.code.length > 0
		? message.code.code
		: `${linterName}/diagnostic`;
}

module.exports = {
	buildSarifResults,
};
