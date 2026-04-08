const fs = require("node:fs");
const path = require("node:path");

const NATIVE_SARIF_FILE = "biome-native.sarif";

function buildSarifResults({
	dedupeResults,
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	runnerTemp,
	sourceRepositoryPath,
	targetPaths,
}) {
	if (linterName !== "biome") {
		return [];
	}

	const run = readNativeSarifRun(runnerTemp);
	if (!run || !Array.isArray(run.results)) {
		return [];
	}

	return dedupeResults(
		run.results.map((result) =>
			normalizeBiomeSarifResult({
				linterName,
				normalizeReportedPath,
				reportedPathRoots,
				result,
				sourceRepositoryPath,
				targetPaths,
			}),
		),
	);
}

function buildSarifRules({ linterName, runnerTemp }) {
	if (linterName !== "biome") {
		return null;
	}

	const rules = readNativeSarifRun(runnerTemp)?.tool?.driver?.rules;
	if (!Array.isArray(rules)) {
		return null;
	}

	return dedupeRules(rules.map((rule) => structuredClone(rule)));
}

function readNativeSarifRun(runnerTemp) {
	if (typeof runnerTemp !== "string" || runnerTemp.length === 0) {
		return null;
	}

	const nativeSarifPath = path.join(runnerTemp, NATIVE_SARIF_FILE);
	if (!fs.existsSync(nativeSarifPath)) {
		return null;
	}

	const parsed = JSON.parse(fs.readFileSync(nativeSarifPath, "utf8"));
	return Array.isArray(parsed?.runs) ? parsed.runs[0] || null : null;
}

function normalizeBiomeSarifResult({
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	result,
	sourceRepositoryPath,
	targetPaths,
}) {
	const normalizedResult = structuredClone(result);
	const normalizedLocations = normalizeLocations({
		locations: normalizedResult.locations,
		normalizeReportedPath,
		reportedPathRoots,
		sourceRepositoryPath,
		targetPaths,
	});

	if (normalizedLocations.length > 0) {
		normalizedResult.locations = normalizedLocations;
	} else {
		delete normalizedResult.locations;
	}

	normalizedResult.properties = {
		...(normalizedResult.properties &&
		typeof normalizedResult.properties === "object"
			? normalizedResult.properties
			: {}),
		linter_name: linterName,
	};

	return normalizedResult;
}

function normalizeLocations({
	locations,
	normalizeReportedPath,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	if (!Array.isArray(locations)) {
		return [];
	}

	return locations.flatMap((location) => {
		const uri = location?.physicalLocation?.artifactLocation?.uri;
		const normalizedUri = normalizeReportedPath(
			sourceRepositoryPath,
			uri,
			targetPaths,
			reportedPathRoots,
		);

		if (!normalizedUri) {
			return [];
		}

		return [
			{
				...location,
				physicalLocation: {
					...(location.physicalLocation &&
					typeof location.physicalLocation === "object"
						? location.physicalLocation
						: {}),
					artifactLocation: {
						...(location?.physicalLocation?.artifactLocation &&
						typeof location.physicalLocation.artifactLocation === "object"
							? location.physicalLocation.artifactLocation
							: {}),
						uri: normalizedUri,
					},
				},
			},
		];
	});
}

function dedupeRules(rules) {
	const seen = new Set();
	const deduped = [];

	for (const rule of rules) {
		const key =
			typeof rule?.id === "string" && rule.id.length > 0
				? rule.id
				: JSON.stringify(rule);
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		deduped.push(rule);
	}

	return deduped;
}

module.exports = {
	buildSarifResults,
	buildSarifRules,
};
