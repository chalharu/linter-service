const fs = require("node:fs");
const path = require("node:path");

const ADVISORY_WARNING_KINDS = new Set(["notice", "unmaintained", "unsound"]);

function parseJsonLines(text) {
	const items = [];
	const rawLines = [];

	for (const rawLine of String(text || "").split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (line.length === 0) {
			continue;
		}

		try {
			items.push(JSON.parse(line));
		} catch {
			rawLines.push(rawLine);
		}
	}

	return { items, rawLines };
}

function isCargoDenyAdvisoryLikeDiagnostic(diagnostic) {
	const fields = diagnostic?.fields;
	const code =
		fields && typeof fields.code === "string" ? fields.code.toLowerCase() : "";

	return (
		Boolean(fields?.advisory) ||
		code === "vulnerability" ||
		ADVISORY_WARNING_KINDS.has(code)
	);
}

function isCargoDenyConfigLikeDiagnostic(diagnostic) {
	const fields = diagnostic?.fields;
	const code =
		fields && typeof fields.code === "string" ? fields.code.toLowerCase() : "";
	const notes = Array.isArray(fields?.notes) ? fields.notes : [];
	const haystack = [fields?.message, code, ...notes].join("\n");

	return /config|deny\.toml|failed to parse/i.test(haystack);
}

function guessCargoDenyDisplayPath(run, diagnostic) {
	if (run.config_path && isCargoDenyConfigLikeDiagnostic(diagnostic)) {
		return run.config_path;
	}

	return run.manifest_path || run.config_path || "";
}

function formatCargoDenyAuditReport(report) {
	const lines = [];
	const vulnerabilities = Array.isArray(report?.vulnerabilities)
		? report.vulnerabilities
		: [];
	const warnings =
		report && typeof report.warnings === "object" && report.warnings
			? report.warnings
			: {};

	for (const entry of vulnerabilities) {
		const advisory = entry?.advisory || {};
		const packageInfo = entry?.package || {};
		const title = advisory.title || advisory.id || "cargo-deny advisory";
		const id = advisory.id || "vulnerability";
		const packageLabel = [packageInfo.name, packageInfo.version]
			.filter(Boolean)
			.join(" ");

		lines.push(
			`error[${id}]: ${packageLabel ? `${packageLabel} - ` : ""}${title}`,
		);
	}

	for (const kind of Object.keys(warnings).sort()) {
		for (const entry of Array.isArray(warnings[kind]) ? warnings[kind] : []) {
			const advisory = entry?.advisory || {};
			const packageInfo = entry?.package || {};
			const title = advisory.title || advisory.id || kind;
			const id = advisory.id || kind;
			const packageLabel = [packageInfo.name, packageInfo.version]
				.filter(Boolean)
				.join(" ");

			lines.push(
				`warning[${id}]: ${packageLabel ? `${packageLabel} - ` : ""}${title}`,
			);
		}
	}

	return lines;
}

function formatCargoDenyDiagnostic(run, diagnostic) {
	const fields = diagnostic?.fields || {};
	const severity =
		typeof fields.severity === "string" && fields.severity.length > 0
			? fields.severity.toLowerCase()
			: "error";
	const code =
		typeof fields.code === "string" && fields.code.length > 0
			? `[${fields.code}]`
			: "";
	const message =
		typeof fields.message === "string" && fields.message.length > 0
			? fields.message
			: "cargo-deny reported an issue";
	const labels = Array.isArray(fields.labels) ? fields.labels : [];
	const notes = Array.isArray(fields.notes) ? fields.notes : [];
	const displayPath = guessCargoDenyDisplayPath(run, diagnostic);
	const lines = [`${severity}${code}: ${message}`];

	for (const label of labels) {
		const line = Number.isInteger(label?.line) ? label.line : 1;
		const column = Number.isInteger(label?.column) ? label.column : 1;
		const labelMessage =
			typeof label?.message === "string" && label.message.length > 0
				? label.message
				: typeof label?.span === "string" && label.span.length > 0
					? label.span
					: message;

		if (displayPath) {
			lines.push(`${displayPath}:${line}:${column}: ${labelMessage}`);
		} else {
			lines.push(labelMessage);
		}
	}

	for (const note of notes) {
		lines.push(`note: ${note}`);
	}

	return lines;
}

function normalizeCargoDenyRun(run) {
	const stdoutText = String(run?.stdout || "");
	const stderrText = String(run?.stderr || "");
	const stdoutParsed = parseJsonLines(stdoutText);
	const stderrParsed = parseJsonLines(stderrText);

	return {
		command: String(run?.command || "").trim(),
		manifest_path: String(run?.manifest_path || "").trim(),
		config_path: String(run?.config_path || "").trim() || null,
		exit_code: Number.isInteger(run?.exit_code)
			? run.exit_code
			: Number.parseInt(String(run?.exit_code || "0"), 10) || 0,
		audit_reports: stdoutParsed.items.filter(
			(item) => item && typeof item === "object",
		),
		diagnostics: stderrParsed.items.filter(
			(item) => item && item.type === "diagnostic" && item.fields,
		),
		stdout_raw_lines: stdoutParsed.rawLines,
		stderr_raw_lines: stderrParsed.rawLines,
	};
}

function renderCargoDenyRunDetails(run) {
	const lines = [];

	if (run.command) {
		lines.push(`==> ${run.command}`);
	}

	const auditLines = run.audit_reports.flatMap(formatCargoDenyAuditReport);
	const filteredDiagnostics =
		run.audit_reports.length > 0
			? run.diagnostics.filter(
					(diagnostic) => !isCargoDenyAdvisoryLikeDiagnostic(diagnostic),
				)
			: run.diagnostics;

	for (const line of auditLines) {
		lines.push(line);
	}

	for (const diagnostic of filteredDiagnostics) {
		lines.push(...formatCargoDenyDiagnostic(run, diagnostic));
	}

	for (const rawLine of [...run.stdout_raw_lines, ...run.stderr_raw_lines]) {
		lines.push(rawLine);
	}

	return lines;
}

function readTextFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return "";
	}

	return fs.readFileSync(filePath, "utf8");
}

function readCargoDenyRunEntries(entriesDir) {
	const entryNames = fs
		.readdirSync(entriesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	return entryNames.map((entryName) => {
		const entryDir = path.join(entriesDir, entryName);

		return {
			command: readTextFile(path.join(entryDir, "command.txt")).trim(),
			config_path: readTextFile(path.join(entryDir, "config_path.txt")).trim(),
			exit_code: readTextFile(path.join(entryDir, "exit_code.txt")).trim(),
			manifest_path: readTextFile(
				path.join(entryDir, "manifest_path.txt"),
			).trim(),
			stderr: readTextFile(path.join(entryDir, "stderr.txt")),
			stdout: readTextFile(path.join(entryDir, "stdout.txt")),
		};
	});
}

function buildCargoDenyResult({ entriesDir, exitCode, runs = null }) {
	const normalizedRuns = (runs || readCargoDenyRunEntries(entriesDir)).map(
		normalizeCargoDenyRun,
	);
	const details = normalizedRuns
		.flatMap((run) => [...renderCargoDenyRunDetails(run), ""])
		.join("\n")
		.trim();

	return {
		cargo_deny_runs: normalizedRuns.map(
			({
				command,
				manifest_path,
				config_path,
				exit_code: runExitCode,
				audit_reports,
				diagnostics,
			}) => ({
				command,
				manifest_path,
				config_path,
				exit_code: runExitCode,
				audit_reports,
				diagnostics,
			}),
		),
		details,
		exit_code: Number.parseInt(String(exitCode), 10) || 0,
	};
}

if (require.main === module) {
	const [entriesDir, exitCodeRaw] = process.argv.slice(2);

	if (!entriesDir || typeof exitCodeRaw !== "string") {
		throw new Error("usage: cargo-deny-result.js <entries-dir> <exit-code>");
	}

	process.stdout.write(
		`${JSON.stringify(
			buildCargoDenyResult({ entriesDir, exitCode: exitCodeRaw }),
		)}\n`,
	);
}

module.exports = {
	buildCargoDenyResult,
	guessCargoDenyDisplayPath,
	isCargoDenyAdvisoryLikeDiagnostic,
	isCargoDenyConfigLikeDiagnostic,
	parseJsonLines,
};
