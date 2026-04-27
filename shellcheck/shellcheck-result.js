const fs = require("node:fs");

const {
	buildSarifFromDiagnostics,
	parsePositiveInteger,
} = require("../.github/scripts/lib/diagnostic-sarif.js");

function readTextFile(filePath) {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return "";
	}

	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readShellcheckReport(filePath) {
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

function normalizePath(filePath) {
	return String(filePath || "")
		.replace(/\\/gu, "/")
		.replace(/^\.\//u, "");
}

function normalizeRuleId(code) {
	if (typeof code === "number" && Number.isInteger(code) && code > 0) {
		return `SC${String(code).padStart(4, "0")}`;
	}

	const normalized = String(code || "")
		.trim()
		.toUpperCase();
	if (normalized.length === 0) {
		return "shellcheck/diagnostic";
	}
	if (normalized.startsWith("SC")) {
		return normalized;
	}
	if (/^\d+$/u.test(normalized)) {
		return `SC${normalized.padStart(4, "0")}`;
	}
	return normalized;
}

function normalizeLevel(level) {
	switch (
		String(level || "")
			.trim()
			.toLowerCase()
	) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
		case "style":
			return "note";
		default:
			return "warning";
	}
}

function collectShellcheckDiagnostics(report) {
	const comments = Array.isArray(report?.comments) ? report.comments : [];

	return comments.map((comment) => {
		const ruleId = normalizeRuleId(comment?.code);
		return {
			column: parsePositiveInteger(comment?.column),
			file_path: normalizePath(comment?.file),
			help_uri: ruleId.startsWith("SC")
				? `https://www.shellcheck.net/wiki/${ruleId}`
				: null,
			level: normalizeLevel(comment?.level),
			line: parsePositiveInteger(comment?.line),
			message:
				typeof comment?.message === "string" &&
				comment.message.trim().length > 0
					? comment.message.trim()
					: "ShellCheck reported an issue.",
			rule_id: ruleId,
		};
	});
}

function buildShellcheckResult({ exitCode, report, stderr }) {
	const diagnostics = collectShellcheckDiagnostics(report);

	if (diagnostics.length > 0 || report) {
		return {
			exit_code: diagnostics.length > 0 ? 1 : exitCode,
			sarif: buildSarifFromDiagnostics({
				defaultRuleId: "shellcheck/diagnostic",
				diagnostics,
				linterName: "shellcheck",
			}),
		};
	}

	const stderrText = typeof stderr === "string" ? stderr.trim() : "";
	return {
		details:
			stderrText.length > 0
				? stderrText
				: exitCode === 0
					? ""
					: "shellcheck failed before producing diagnostic output.",
		exit_code: exitCode,
	};
}

function runCli(argv = process.argv.slice(2)) {
	const [reportPath, stderrPath, exitCodeRaw] = argv;
	process.stdout.write(
		`${JSON.stringify(
			buildShellcheckResult({
				exitCode: Number.parseInt(exitCodeRaw || "0", 10) || 0,
				report: readShellcheckReport(reportPath),
				stderr: readTextFile(stderrPath),
			}),
		)}\n`,
	);
}

if (require.main === module) {
	runCli();
}

module.exports = {
	buildShellcheckResult,
	collectShellcheckDiagnostics,
	normalizeRuleId,
};
