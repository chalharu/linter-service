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

function readTextlintReport(filePath) {
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

function normalizePath(filePath, tempRepo) {
	let normalized = String(filePath || "").replace(/\\/gu, "/");
	const prefixes = [
		`${String(tempRepo || "")
			.replace(/\\/gu, "/")
			.replace(/\/$/u, "")}/`,
		"/work/",
	];

	for (const prefix of prefixes) {
		if (prefix !== "/" && normalized.startsWith(prefix)) {
			normalized = normalized.slice(prefix.length);
			break;
		}
	}

	return normalized.replace(/^\.\//u, "");
}

function normalizeSeverity(severity) {
	switch (severity) {
		case 1:
			return "warning";
		case 2:
			return "error";
		case 3:
			return "note";
		default:
			return "error";
	}
}

function collectTextlintDiagnostics(report, tempRepo) {
	const results = Array.isArray(report) ? report : [];

	return results.flatMap((entry) => {
		const filePath = normalizePath(entry?.filePath, tempRepo);
		const messages = Array.isArray(entry?.messages) ? entry.messages : [];

		return messages.map((message) => ({
			column: parsePositiveInteger(message?.column),
			file_path: filePath,
			level: normalizeSeverity(message?.severity),
			line: parsePositiveInteger(message?.line),
			message:
				typeof message?.message === "string" &&
				message.message.trim().length > 0
					? message.message.trim()
					: "textlint reported an issue.",
			rule_id:
				typeof message?.ruleId === "string" && message.ruleId.trim().length > 0
					? message.ruleId.trim()
					: "textlint/diagnostic",
		}));
	});
}

function buildTextlintResult({ exitCode, report, stderr, tempRepo }) {
	const diagnostics = collectTextlintDiagnostics(report, tempRepo);

	if (diagnostics.length > 0 || (Array.isArray(report) && exitCode <= 1)) {
		return {
			exit_code: diagnostics.length > 0 ? 1 : exitCode,
			sarif: buildSarifFromDiagnostics({
				defaultRuleId: "textlint/diagnostic",
				diagnostics,
				linterName: "textlint",
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
					: "textlint failed before producing diagnostic output.",
		exit_code: exitCode,
	};
}

function runCli(argv = process.argv.slice(2)) {
	const [reportPath, stderrPath, tempRepo, exitCodeRaw] = argv;
	process.stdout.write(
		`${JSON.stringify(
			buildTextlintResult({
				exitCode: Number.parseInt(exitCodeRaw || "0", 10) || 0,
				report: readTextlintReport(reportPath),
				stderr: readTextFile(stderrPath),
				tempRepo,
			}),
		)}\n`,
	);
}

if (require.main === module) {
	runCli();
}

module.exports = {
	buildTextlintResult,
	collectTextlintDiagnostics,
};
