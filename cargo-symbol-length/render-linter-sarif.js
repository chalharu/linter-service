function buildSarifResults({
	createResult,
	dedupeResults,
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	result,
	sourceRepositoryPath,
	targetPaths,
}) {
	if (linterName !== "cargo-symbol-length") {
		return [];
	}

	const runs = Array.isArray(result?.cargo_symbol_length_runs)
		? result.cargo_symbol_length_runs
		: [];

	const results = [];

	for (const run of runs) {
		const findings = Array.isArray(run?.findings) ? run.findings : [];

		for (const finding of findings) {
			const reportedPath =
				typeof finding?.target_src_path === "string" &&
				finding.target_src_path.length > 0
					? finding.target_src_path
					: typeof run?.manifest_path === "string" &&
							run.manifest_path.length > 0
						? run.manifest_path
						: null;

			const filePath = reportedPath
				? normalizeReportedPath(
						sourceRepositoryPath,
						reportedPath,
						targetPaths,
						reportedPathRoots,
					)
				: null;

			const length =
				typeof finding?.length === "number" ? finding.length : null;
			const symbol =
				typeof finding?.symbol === "string" ? finding.symbol : "<unknown>";

			results.push(
				createResult({
					column: filePath ? 1 : null,
					filePath,
					level: "error",
					line: filePath ? 1 : null,
					linterName,
					message: buildFindingMessage(symbol, length),
					ruleId: "cargo-symbol-length/symbol-too-long",
				}),
			);
		}
	}

	return dedupeResults(results);
}

function buildSarifRules({ result }) {
	const runs = Array.isArray(result?.cargo_symbol_length_runs)
		? result.cargo_symbol_length_runs
		: [];

	const hasFindings = runs.some(
		(run) => Array.isArray(run?.findings) && run.findings.length > 0,
	);

	if (!hasFindings) {
		return [];
	}

	return [
		{
			id: "cargo-symbol-length/symbol-too-long",
			name: "SymbolTooLong",
			shortDescription: {
				text: "Symbol name length exceeds configured threshold",
			},
		},
	];
}

function buildFindingMessage(symbol, length) {
	const truncatedSymbol =
		symbol.length > 120 ? `${symbol.slice(0, 120)}…` : symbol;
	return length !== null
		? `Symbol name is ${length} characters long (exceeds threshold): ${truncatedSymbol}`
		: `Symbol name exceeds threshold: ${truncatedSymbol}`;
}

module.exports = {
	buildSarifResults,
	buildSarifRules,
};
