const fs = require("node:fs");
const path = require("node:path");
const {
	parseJsonLines,
} = require("../.github/scripts/lib/parse-json-lines.js");

const DEFAULT_CARGO_CLIPPY_MESSAGE = "cargo-clippy reported an issue";
const WORK_ROOT_PREFIX = "/work/";

function readTextFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return "";
	}

	return fs.readFileSync(filePath, "utf8");
}

function readCargoClippyRunEntries(entriesDir) {
	if (!fs.existsSync(entriesDir)) {
		return [];
	}

	const entryNames = fs
		.readdirSync(entriesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	return entryNames.map((entryName) => {
		const entryDir = path.join(entriesDir, entryName);

		return {
			command: readTextFile(path.join(entryDir, "command.txt")).trim(),
			exit_code: readTextFile(path.join(entryDir, "exit_code.txt")).trim(),
			manifest_path: readTextFile(
				path.join(entryDir, "manifest_path.txt"),
			).trim(),
			stderr: readTextFile(path.join(entryDir, "stderr.txt")),
			stdout: readTextFile(path.join(entryDir, "stdout.txt")),
		};
	});
}

function normalizeCargoClippyPath(value) {
	if (typeof value !== "string") {
		return value ?? null;
	}

	return value.startsWith(WORK_ROOT_PREFIX)
		? value.slice(WORK_ROOT_PREFIX.length)
		: value;
}

function normalizeCargoClippyRendered(rendered) {
	if (typeof rendered !== "string" || rendered.length === 0) {
		return null;
	}

	return rendered.replaceAll(WORK_ROOT_PREFIX, "").trimEnd();
}

function normalizeCargoClippySpan(span) {
	if (!span || typeof span !== "object") {
		return null;
	}

	return {
		...span,
		file_name: normalizeCargoClippyPath(span.file_name),
		expansion:
			span.expansion && typeof span.expansion === "object"
				? {
						...span.expansion,
						def_site_span: normalizeCargoClippySpan(
							span.expansion.def_site_span,
						),
						span: normalizeCargoClippySpan(span.expansion.span),
					}
				: (span.expansion ?? null),
	};
}

function normalizeCargoClippyMessage(message) {
	if (!message || typeof message !== "object") {
		return {
			children: [],
			code: null,
			level: "error",
			message: DEFAULT_CARGO_CLIPPY_MESSAGE,
			rendered: null,
			spans: [],
		};
	}

	return {
		...message,
		children: Array.isArray(message.children)
			? message.children.map((child) => ({
					...child,
					rendered: normalizeCargoClippyRendered(child?.rendered),
					spans: Array.isArray(child?.spans)
						? child.spans
								.map(normalizeCargoClippySpan)
								.filter((span) => span !== null)
						: [],
				}))
			: [],
		code:
			message.code && typeof message.code === "object" ? message.code : null,
		level: typeof message.level === "string" ? message.level : "error",
		message:
			typeof message.message === "string" && message.message.length > 0
				? message.message
				: DEFAULT_CARGO_CLIPPY_MESSAGE,
		rendered: normalizeCargoClippyRendered(message.rendered),
		spans: Array.isArray(message.spans)
			? message.spans
					.map(normalizeCargoClippySpan)
					.filter((span) => span !== null)
			: [],
	};
}

function isCargoClippyStructuredMessage(item) {
	return item && item.reason === "compiler-message" && item.message;
}

function isCargoClippyWarningDiagnostic(diagnostic) {
	return diagnostic.message.level === "warning";
}

function isCargoClippyActionableDiagnostic(diagnostic) {
	return !["failure-note", "help", "note"].includes(diagnostic.message.level);
}

function buildCargoClippyDiagnosticKey(diagnostic) {
	const message =
		diagnostic?.message && typeof diagnostic.message === "object"
			? diagnostic.message
			: {};
	const span = resolveCargoClippyPrimarySpan(message);

	return [
		typeof diagnostic?.manifest_path === "string"
			? diagnostic.manifest_path
			: "",
		typeof message.level === "string" ? message.level : "",
		typeof message?.code?.code === "string" ? message.code.code : "",
		typeof message.message === "string" ? message.message : "",
		typeof message.rendered === "string" ? message.rendered : "",
		typeof span?.file_name === "string" ? span.file_name : "",
		String(span?.line_start || 0),
		String(span?.column_start || 0),
	].join("\u0000");
}

function dedupeCargoClippyDiagnostics(diagnostics) {
	const seen = new Set();

	return diagnostics.filter((diagnostic) => {
		const key = buildCargoClippyDiagnosticKey(diagnostic);

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);
		return true;
	});
}

function normalizeCargoClippyRun(run) {
	const stdoutParsed = parseJsonLines(String(run?.stdout || ""));
	const stderrParsed = parseJsonLines(String(run?.stderr || ""));
	const structuredMessages = [...stdoutParsed.items, ...stderrParsed.items]
		.filter(isCargoClippyStructuredMessage)
		.map((item) => ({
			command: typeof run?.command === "string" ? run.command.trim() : "",
			manifest_path:
				typeof item.manifest_path === "string" && item.manifest_path.length > 0
					? normalizeCargoClippyPath(item.manifest_path)
					: typeof run?.manifest_path === "string"
						? run.manifest_path.trim()
						: "",
			message: normalizeCargoClippyMessage(item.message),
			package_id:
				typeof item.package_id === "string" && item.package_id.length > 0
					? item.package_id
					: null,
			target:
				item.target && typeof item.target === "object"
					? {
							kind: Array.isArray(item.target.kind) ? item.target.kind : [],
							name:
								typeof item.target.name === "string" ? item.target.name : "",
							src_path: normalizeCargoClippyPath(item.target.src_path),
						}
					: null,
		}))
		.filter(isCargoClippyActionableDiagnostic);
	const dedupedStructuredMessages =
		dedupeCargoClippyDiagnostics(structuredMessages);
	const diagnostics = dedupedStructuredMessages.filter(
		(diagnostic) => !isCargoClippyWarningDiagnostic(diagnostic),
	);
	const warning_diagnostics = dedupedStructuredMessages.filter(
		isCargoClippyWarningDiagnostic,
	);

	return {
		command: typeof run?.command === "string" ? run.command.trim() : "",
		diagnostics,
		exit_code: Number.isInteger(run?.exit_code)
			? run.exit_code
			: Number.parseInt(String(run?.exit_code || "0"), 10) || 0,
		manifest_path:
			typeof run?.manifest_path === "string" ? run.manifest_path.trim() : "",
		stderr_raw_lines: stderrParsed.rawLines,
		stdout_raw_lines: stdoutParsed.rawLines,
		warning_diagnostics,
	};
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

function formatCargoClippyDiagnostic(message) {
	if (typeof message?.rendered === "string" && message.rendered.length > 0) {
		return message.rendered;
	}

	const span = resolveCargoClippyPrimarySpan(message);
	const code =
		typeof message?.code?.code === "string" && message.code.code.length > 0
			? `[${message.code.code}]`
			: "";
	const lines = [
		`${message?.level || "error"}${code}: ${message?.message || DEFAULT_CARGO_CLIPPY_MESSAGE}`,
	];

	if (span?.file_name) {
		lines.push(
			` --> ${span.file_name}:${span.line_start || 1}:${span.column_start || 1}`,
		);
	}

	for (const child of Array.isArray(message?.children)
		? message.children
		: []) {
		if (typeof child?.rendered === "string" && child.rendered.length > 0) {
			lines.push(child.rendered);
			continue;
		}

		if (typeof child?.message === "string" && child.message.length > 0) {
			lines.push(`${child.level || "note"}: ${child.message}`);
		}
	}

	return lines.join("\n");
}

function renderCargoClippyRunDetails(run) {
	const blocks = [];
	const rawLines = [...run.stdout_raw_lines, ...run.stderr_raw_lines]
		.map((line) => String(line).trimEnd())
		.filter((line) => line.trim().length > 0);
	const progressLines = rawLines.filter((line) =>
		/^\s*(?:Checking|Compiling|Finished)\b/u.test(line),
	);
	const trailingLines = rawLines.filter(
		(line) => !/^\s*(?:Checking|Compiling|Finished)\b/u.test(line),
	);

	if (run.command) {
		blocks.push(`==> ${run.command}`);
	}

	if (progressLines.length > 0) {
		blocks.push(progressLines.join("\n"));
	}

	for (const diagnostic of [...run.diagnostics, ...run.warning_diagnostics]) {
		blocks.push(formatCargoClippyDiagnostic(diagnostic.message));
	}

	if (trailingLines.length > 0) {
		blocks.push(trailingLines.join("\n"));
	}

	return blocks.join("\n");
}

function buildCargoClippyResult({
	detailsPath = null,
	detailsText = null,
	entriesDir,
	exitCode,
	runs = null,
}) {
	const normalizedRuns = (runs || readCargoClippyRunEntries(entriesDir)).map(
		normalizeCargoClippyRun,
	);
	const requestedExitCode = Number.parseInt(String(exitCode), 10) || 0;
	const warningCount = normalizedRuns.reduce(
		(count, run) => count + run.warning_diagnostics.length,
		0,
	);
	const preludeDetails =
		typeof detailsText === "string"
			? detailsText.trim()
			: typeof detailsPath === "string" && detailsPath.length > 0
				? readTextFile(detailsPath).trim()
				: "";
	const details = [preludeDetails]
		.concat(normalizedRuns.map(renderCargoClippyRunDetails))
		.filter((block) => typeof block === "string" && block.trim().length > 0)
		.join("\n\n")
		.trim();
	const structuredRuns = normalizedRuns.filter(
		(run) => run.diagnostics.length > 0 || run.warning_diagnostics.length > 0,
	);

	return {
		...(structuredRuns.length > 0
			? {
					cargo_clippy_runs: structuredRuns.map(
						({
							command,
							diagnostics,
							exit_code: runExitCode,
							manifest_path,
							warning_diagnostics,
						}) => ({
							command,
							diagnostics,
							exit_code: runExitCode,
							manifest_path,
							...(warning_diagnostics.length > 0
								? { warning_diagnostics }
								: {}),
						}),
					),
				}
			: {}),
		details,
		exit_code: requestedExitCode,
		...(warningCount > 0 ? { warning_count: warningCount } : {}),
	};
}

if (require.main === module) {
	const [entriesDir, detailsPath, exitCodeRaw, structuredRunsPath] =
		process.argv.slice(2);

	if (!entriesDir || !detailsPath || typeof exitCodeRaw !== "string") {
		throw new Error(
			"usage: cargo-clippy-result.js <entries-dir> <details-path> <exit-code> [structured-runs-path]",
		);
	}

	const result = buildCargoClippyResult({
		detailsPath,
		entriesDir,
		exitCode: exitCodeRaw,
	});
	if (typeof structuredRunsPath === "string" && structuredRunsPath.length > 0) {
		fs.writeFileSync(
			structuredRunsPath,
			JSON.stringify(
				Array.isArray(result.cargo_clippy_runs) ? result.cargo_clippy_runs : [],
			),
			"utf8",
		);
		delete result.cargo_clippy_runs;
	}

	process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
	buildCargoClippyResult,
	readCargoClippyRunEntries,
};
