const {
	isCargoDenyAdvisoryLikeDiagnostic,
	isCargoDenyConfigLikeDiagnostic,
} = require("./cargo-deny-result.js");

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
	toSarifLevel,
}) {
	if (linterName !== "cargo-deny") {
		return [];
	}

	const cargoDenyRuns = Array.isArray(result?.cargo_deny_runs)
		? result.cargo_deny_runs
		: [];

	if (cargoDenyRuns.length === 0) {
		return [];
	}

	const results = [];

	for (const run of cargoDenyRuns) {
		const advisoryResults = parseCargoDenyAuditReportResults({
			createResult,
			defaultLevel,
			linterName,
			normalizeReportedPath,
			reportedPathRoots,
			run,
			sourceRepositoryPath,
			targetPaths,
		});
		const diagnosticResults = parseCargoDenyJsonDiagnostics({
			createResult,
			defaultLevel,
			linterName,
			normalizeReportedPath,
			parseInteger,
			reportedPathRoots,
			run,
			skipAdvisories: advisoryResults.length > 0,
			sourceRepositoryPath,
			targetPaths,
			toSarifLevel,
		});

		results.push(...advisoryResults, ...diagnosticResults);
	}

	return dedupeResults(results);
}

function parseCargoDenyAuditReportResults({
	createResult,
	defaultLevel,
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	run,
	sourceRepositoryPath,
	targetPaths,
}) {
	const results = [];
	const auditReports = Array.isArray(run?.audit_reports)
		? run.audit_reports
		: [];
	const manifestPath = normalizeCargoDenyStructuredPath(
		normalizeReportedPath,
		sourceRepositoryPath,
		run?.manifest_path,
		targetPaths,
		reportedPathRoots,
	);
	const defaultFilePath =
		manifestPath ||
		normalizeCargoDenyStructuredPath(
			normalizeReportedPath,
			sourceRepositoryPath,
			run?.config_path,
			targetPaths,
			reportedPathRoots,
		);

	for (const report of auditReports) {
		for (const vulnerability of Array.isArray(report?.vulnerabilities)
			? report.vulnerabilities
			: []) {
			const advisory = vulnerability?.advisory || {};
			const packageInfo = vulnerability?.package || {};
			const packageLabel = [packageInfo.name, packageInfo.version]
				.filter(Boolean)
				.join(" ");
			const title = advisory.title || advisory.id || "cargo-deny advisory";

			results.push(
				createResult({
					column: defaultFilePath ? 1 : null,
					defaultLevel,
					filePath: defaultFilePath,
					line: defaultFilePath ? 1 : null,
					linterName,
					message: packageLabel ? `${packageLabel}: ${title}` : title,
					ruleId: advisory.id || "cargo-deny/advisory",
				}),
			);
		}

		for (const [kind, entries] of Object.entries(
			report && typeof report.warnings === "object" && report.warnings
				? report.warnings
				: {},
		)) {
			for (const warning of Array.isArray(entries) ? entries : []) {
				const advisory = warning?.advisory || {};
				const packageInfo = warning?.package || {};
				const packageLabel = [packageInfo.name, packageInfo.version]
					.filter(Boolean)
					.join(" ");
				const title = advisory.title || advisory.id || kind;

				results.push(
					createResult({
						column: defaultFilePath ? 1 : null,
						defaultLevel,
						filePath: defaultFilePath,
						line: defaultFilePath ? 1 : null,
						linterName,
						message: packageLabel ? `${packageLabel}: ${title}` : title,
						ruleId: advisory.id || `cargo-deny/${kind}`,
					}),
				);
			}
		}
	}

	return results;
}

function parseCargoDenyJsonDiagnostics({
	createResult,
	defaultLevel,
	linterName,
	normalizeReportedPath,
	parseInteger,
	reportedPathRoots,
	run,
	skipAdvisories,
	sourceRepositoryPath,
	targetPaths,
	toSarifLevel,
}) {
	const results = [];
	const diagnostics = Array.isArray(run?.diagnostics) ? run.diagnostics : [];
	const manifestPath = normalizeCargoDenyStructuredPath(
		normalizeReportedPath,
		sourceRepositoryPath,
		run?.manifest_path,
		targetPaths,
		reportedPathRoots,
	);
	const configPath = normalizeCargoDenyStructuredPath(
		normalizeReportedPath,
		sourceRepositoryPath,
		run?.config_path,
		targetPaths,
		reportedPathRoots,
	);

	for (const diagnostic of diagnostics) {
		if (skipAdvisories && isCargoDenyAdvisoryLikeDiagnostic(diagnostic)) {
			continue;
		}

		const fields = diagnostic?.fields || {};
		const label = Array.isArray(fields.labels) ? fields.labels[0] : null;
		const filePath =
			configPath && isCargoDenyConfigLikeDiagnostic(diagnostic)
				? configPath
				: manifestPath || configPath;
		const useLabelRegion = filePath === configPath && label;
		const line = filePath
			? useLabelRegion
				? parseInteger(label?.line)
				: 1
			: null;
		const column = filePath
			? useLabelRegion
				? parseInteger(label?.column)
				: 1
			: null;

		results.push(
			createResult({
				column,
				defaultLevel:
					typeof fields.severity === "string"
						? toSarifLevel(fields.severity, defaultLevel)
						: defaultLevel,
				filePath,
				line,
				linterName,
				message:
					typeof fields.message === "string" && fields.message.length > 0
						? fields.message
						: summarizeCargoDenyDiagnostic(diagnostic),
				ruleId: resolveCargoDenyRuleId(fields, linterName),
			}),
		);
	}

	return results;
}

function normalizeCargoDenyStructuredPath(
	normalizeReportedPath,
	sourceRepositoryPath,
	reportedPath,
	targetPaths,
	reportedPathRoots,
) {
	if (typeof reportedPath !== "string" || reportedPath.trim().length === 0) {
		return null;
	}

	return normalizeReportedPath(
		sourceRepositoryPath,
		reportedPath,
		targetPaths,
		reportedPathRoots,
	);
}

function resolveCargoDenyRuleId(fields, linterName) {
	if (
		typeof fields?.advisory?.id === "string" &&
		fields.advisory.id.length > 0
	) {
		return fields.advisory.id;
	}

	if (typeof fields?.code === "string" && fields.code.length > 0) {
		return `cargo-deny/${fields.code}`;
	}

	if (Array.isArray(fields?.notes)) {
		for (const note of fields.notes) {
			const match = /^ID:\s*(.+)$/u.exec(String(note || "").trim());

			if (match?.[1]) {
				return match[1];
			}
		}
	}

	return `${linterName}/diagnostic`;
}

function summarizeCargoDenyDiagnostic(diagnostic) {
	const fields = diagnostic?.fields || {};
	const label = Array.isArray(fields.labels) ? fields.labels[0] : null;

	if (typeof label?.message === "string" && label.message.length > 0) {
		return label.message;
	}

	if (typeof label?.span === "string" && label.span.length > 0) {
		return label.span;
	}

	return "cargo-deny reported an issue";
}

module.exports = {
	buildSarifResults,
};
