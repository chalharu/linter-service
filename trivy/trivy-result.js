const fs = require("node:fs");

function renderTrivyDetails({ exitCode, report, stderr }) {
	const diagnostics = collectTrivyDiagnostics(report);
	if (diagnostics.length > 0) {
		return diagnostics.map(formatTrivyDiagnostic).join("\n");
	}

	const stderrText = typeof stderr === "string" ? stderr.trim() : "";
	if (stderrText.length > 0) {
		return stderrText;
	}

	return exitCode === 0
		? ""
		: "trivy failed before producing diagnostic output.";
}

function collectTrivyDiagnostics(report) {
	const diagnostics = [];

	for (const result of Array.isArray(report?.Results) ? report.Results : []) {
		for (const misconfiguration of Array.isArray(result?.Misconfigurations)
			? result.Misconfigurations
			: []) {
			diagnostics.push(
				buildTrivyDiagnostic({
					misconfiguration,
					target: result?.Target,
				}),
			);
		}
	}

	return diagnostics.sort(compareTrivyDiagnostics);
}

function buildTrivyDiagnostic({ misconfiguration, target }) {
	const severity = normalizeSeverity(misconfiguration?.Severity);
	return {
		column: 1,
		level: severityToLinterLevel(severity),
		line: parsePositiveInteger(misconfiguration?.CauseMetadata?.StartLine) ?? 1,
		message: resolveTrivyMessage(misconfiguration),
		ruleId:
			typeof misconfiguration?.ID === "string" && misconfiguration.ID.length > 0
				? misconfiguration.ID
				: "trivy/diagnostic",
		severity,
		target: normalizePath(target || "Dockerfile"),
	};
}

function resolveTrivyMessage(misconfiguration) {
	if (
		typeof misconfiguration?.Message === "string" &&
		misconfiguration.Message.length > 0
	) {
		return misconfiguration.Message;
	}

	if (
		typeof misconfiguration?.Title === "string" &&
		misconfiguration.Title.length > 0
	) {
		return misconfiguration.Title;
	}

	if (
		typeof misconfiguration?.Description === "string" &&
		misconfiguration.Description.length > 0
	) {
		return misconfiguration.Description;
	}

	return "Trivy reported a misconfiguration.";
}

function formatTrivyDiagnostic(diagnostic) {
	return `${diagnostic.target}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.level} ${diagnostic.ruleId} (${diagnostic.severity}): ${diagnostic.message}`;
}

function compareTrivyDiagnostics(left, right) {
	return [
		left.target,
		String(left.line),
		String(left.column),
		left.ruleId,
		left.message,
	]
		.join("\u0000")
		.localeCompare(
			[
				right.target,
				String(right.line),
				String(right.column),
				right.ruleId,
				right.message,
			].join("\u0000"),
		);
}

function normalizeSeverity(value) {
	const severity = String(value || "")
		.trim()
		.toUpperCase();
	return ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)
		? severity
		: "UNKNOWN";
}

function severityToLinterLevel(severity) {
	return severity === "HIGH" || severity === "CRITICAL" ? "error" : "warning";
}

function normalizePath(filePath) {
	return String(filePath || "")
		.replace(/\\/gu, "/")
		.replace(/^\.\//u, "");
}

function parsePositiveInteger(value) {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? value : null;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readTextFile(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return "";
	}

	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readTrivyReport(filePath) {
	const source = readTextFile(filePath);
	if (source.trim().length === 0) {
		return null;
	}

	try {
		return JSON.parse(source);
	} catch {
		return null;
	}
}

function runCli(argv = process.argv.slice(2)) {
	const [reportPath, stderrPath, exitCodeRaw] = argv;
	const details = renderTrivyDetails({
		exitCode: Number.parseInt(exitCodeRaw || "0", 10) || 0,
		report: readTrivyReport(reportPath),
		stderr: readTextFile(stderrPath),
	});

	if (details.length > 0) {
		process.stdout.write(`${details}\n`);
	}
}

if (require.main === module) {
	runCli();
}

module.exports = {
	buildTrivyDiagnostic,
	collectTrivyDiagnostics,
	formatTrivyDiagnostic,
	readTrivyReport,
	renderTrivyDetails,
	severityToLinterLevel,
};
