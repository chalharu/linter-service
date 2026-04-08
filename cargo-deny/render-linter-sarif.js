const {
	isCargoDenyAdvisoryLikeDiagnostic,
	isCargoDenyConfigLikeDiagnostic,
} = require("./cargo-deny-result.js");
const {
	buildCargoDenyPackageLabel,
	listCargoDenyWarningKinds,
	normalizeCargoDenyWarningEntries,
	normalizeCargoDenyWarnings,
} = require("./common.js");

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

function normalizeCargoDenyAuditReports(run) {
	return Array.isArray(run?.audit_reports) ? run.audit_reports : [];
}

function normalizeCargoDenyVulnerabilities(report) {
	return Array.isArray(report?.vulnerabilities) ? report.vulnerabilities : [];
}

function normalizeCargoDenyDiagnostics(run) {
	return Array.isArray(run?.diagnostics) ? run.diagnostics : [];
}

function resolveCargoDenyAuditMessage({
	advisory,
	fallbackTitle,
	packageInfo,
}) {
	const title = advisory?.title || advisory?.id || fallbackTitle;
	const packageLabel = buildCargoDenyPackageLabel(packageInfo);

	return packageLabel ? `${packageLabel}: ${title}` : title;
}

function resolveCargoDenyRunPaths({
	normalizeReportedPath,
	reportedPathRoots,
	run,
	sourceRepositoryPath,
	targetPaths,
}) {
	return {
		configPath: normalizeCargoDenyStructuredPath(
			normalizeReportedPath,
			sourceRepositoryPath,
			run?.config_path,
			targetPaths,
			reportedPathRoots,
		),
		manifestPath: normalizeCargoDenyStructuredPath(
			normalizeReportedPath,
			sourceRepositoryPath,
			run?.manifest_path,
			targetPaths,
			reportedPathRoots,
		),
	};
}

function createCargoDenyAuditSarifResult({
	createResult,
	defaultFilePath,
	defaultLevel,
	fallbackRuleId,
	fallbackTitle,
	finding,
	linterName,
}) {
	return createResult({
		column: defaultFilePath ? 1 : null,
		defaultLevel,
		filePath: defaultFilePath,
		line: defaultFilePath ? 1 : null,
		linterName,
		message: resolveCargoDenyAuditMessage({
			advisory: finding?.advisory,
			fallbackTitle,
			packageInfo: finding?.package,
		}),
		ruleId: finding?.advisory?.id || fallbackRuleId,
	});
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
	const auditReports = normalizeCargoDenyAuditReports(run);
	const { configPath, manifestPath } = resolveCargoDenyRunPaths({
		normalizeReportedPath,
		reportedPathRoots,
		run,
		sourceRepositoryPath,
		targetPaths,
	});
	const defaultFilePath = manifestPath || configPath;

	return auditReports.flatMap((report) => [
		...normalizeCargoDenyVulnerabilities(report).map((vulnerability) =>
			createCargoDenyAuditSarifResult({
				createResult,
				defaultFilePath,
				defaultLevel,
				fallbackRuleId: "cargo-deny/advisory",
				fallbackTitle: "cargo-deny advisory",
				finding: vulnerability,
				linterName,
			}),
		),
		...listCargoDenyWarningKinds(report?.warnings).flatMap((kind) =>
			normalizeCargoDenyWarningEntries(
				normalizeCargoDenyWarnings(report?.warnings)[kind],
			).map((warning) =>
				createCargoDenyAuditSarifResult({
					createResult,
					defaultFilePath,
					defaultLevel,
					fallbackRuleId: `cargo-deny/${kind}`,
					fallbackTitle: kind,
					finding: warning,
					linterName,
				}),
			),
		),
	]);
}

function resolveCargoDenyPrimaryLabel(fields) {
	return Array.isArray(fields.labels) ? fields.labels[0] : null;
}

function resolveCargoDenyDiagnosticFilePath({
	configPath,
	diagnostic,
	manifestPath,
}) {
	if (configPath && isCargoDenyConfigLikeDiagnostic(diagnostic)) {
		return configPath;
	}

	return manifestPath || configPath;
}

function resolveCargoDenyDiagnosticRegion({
	configPath,
	filePath,
	label,
	parseInteger,
}) {
	if (!filePath) {
		return {
			column: null,
			line: null,
		};
	}

	if (filePath !== configPath || !label) {
		return {
			column: 1,
			line: 1,
		};
	}

	return {
		column: parseInteger(label?.column),
		line: parseInteger(label?.line),
	};
}

function resolveCargoDenyDiagnosticLevel({
	defaultLevel,
	fields,
	toSarifLevel,
}) {
	return typeof fields.severity === "string"
		? toSarifLevel(fields.severity, defaultLevel)
		: defaultLevel;
}

function resolveCargoDenySarifMessage(fields, diagnostic) {
	return typeof fields.message === "string" && fields.message.length > 0
		? fields.message
		: summarizeCargoDenyDiagnostic(diagnostic);
}

function createCargoDenyDiagnosticResult({
	configPath,
	createResult,
	defaultLevel,
	diagnostic,
	linterName,
	manifestPath,
	parseInteger,
	toSarifLevel,
}) {
	const fields = diagnostic?.fields || {};
	const label = resolveCargoDenyPrimaryLabel(fields);
	const filePath = resolveCargoDenyDiagnosticFilePath({
		configPath,
		diagnostic,
		manifestPath,
	});
	const { column, line } = resolveCargoDenyDiagnosticRegion({
		configPath,
		filePath,
		label,
		parseInteger,
	});

	return createResult({
		column,
		defaultLevel: resolveCargoDenyDiagnosticLevel({
			defaultLevel,
			fields,
			toSarifLevel,
		}),
		filePath,
		line,
		linterName,
		message: resolveCargoDenySarifMessage(fields, diagnostic),
		ruleId: resolveCargoDenyRuleId(fields, linterName),
	});
}

function filterCargoDenyDiagnostics(diagnostics, skipAdvisories) {
	if (!skipAdvisories) {
		return diagnostics;
	}

	return diagnostics.filter(
		(diagnostic) => !isCargoDenyAdvisoryLikeDiagnostic(diagnostic),
	);
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
	const diagnostics = normalizeCargoDenyDiagnostics(run);
	const { configPath, manifestPath } = resolveCargoDenyRunPaths({
		normalizeReportedPath,
		reportedPathRoots,
		run,
		sourceRepositoryPath,
		targetPaths,
	});

	return filterCargoDenyDiagnostics(diagnostics, skipAdvisories).map(
		(diagnostic) =>
			createCargoDenyDiagnosticResult({
				configPath,
				createResult,
				defaultLevel,
				diagnostic,
				linterName,
				manifestPath,
				parseInteger,
				toSarifLevel,
			}),
	);
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
