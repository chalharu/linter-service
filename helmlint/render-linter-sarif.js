function buildSarifResults({
	createResult,
	dedupeResults,
	defaultLevel,
	linterName,
	normalizeReportedPath,
	parseInteger,
	reportedPathRoots,
	result,
	sourceRepositoryPath,
	targetPaths,
}) {
	const details =
		result && typeof result.details === "string" ? result.details : "";
	const results = [];
	let currentChartRoot = null;

	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (line.length === 0 || line.startsWith("Error: ")) {
			continue;
		}

		const chartMatch = /^==>\s+(?:helm lint|Linting)\s+(?<chartRoot>.+)$/u.exec(
			line,
		);
		if (chartMatch?.groups?.chartRoot) {
			currentChartRoot = chartMatch.groups.chartRoot.trim();
			continue;
		}

		const diagnosticMatch =
			/^\[(?<level>INFO|WARNING|ERROR)\]\s+(?<path>[^:]+):\s*(?<message>.+)$/u.exec(
				line,
			);
		if (!diagnosticMatch?.groups) {
			continue;
		}

		const filePath = resolveHelmLintPath({
			currentChartRoot,
			normalizeReportedPath,
			reportedPath: diagnosticMatch.groups.path.trim(),
			reportedPathRoots,
			sourceRepositoryPath,
			targetPaths,
		});
		const lineMatch = /\bline (?<line>\d+)\b/u.exec(
			diagnosticMatch.groups.message,
		);

		results.push(
			createResult({
				defaultLevel,
				filePath,
				line: parseInteger(lineMatch?.groups?.line ?? null),
				level:
					{
						ERROR: "error",
						INFO: "note",
						WARNING: "warning",
					}[diagnosticMatch.groups.level] ?? defaultLevel,
				linterName,
				message: line,
				ruleId: `${linterName}/diagnostic`,
			}),
		);
	}

	return dedupeResults(results);
}

function resolveHelmLintPath({
	currentChartRoot,
	normalizeReportedPath,
	reportedPath,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const candidates = [];

	if (reportedPath.length > 0) {
		candidates.push(reportedPath);
	}

	if (
		typeof currentChartRoot === "string" &&
		currentChartRoot.length > 0 &&
		reportedPath.length > 0 &&
		reportedPath !== "."
	) {
		candidates.push(
			currentChartRoot === "."
				? reportedPath
				: `${currentChartRoot}/${reportedPath}`,
		);
	}

	if (typeof currentChartRoot === "string" && currentChartRoot.length > 0) {
		candidates.push(currentChartRoot);
	}

	for (const candidate of candidates) {
		const resolved = normalizeReportedPath(
			sourceRepositoryPath,
			candidate,
			targetPaths,
			reportedPathRoots,
		);
		if (resolved) {
			return resolved;
		}
	}

	return null;
}

module.exports = {
	buildSarifResults,
};
