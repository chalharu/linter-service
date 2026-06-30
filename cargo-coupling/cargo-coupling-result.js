const fs = require("node:fs");
const path = require("node:path");

const {
	evaluateCargoCouplingCheck,
	normalizeCargoCouplingConfig,
} = require("./cargo-coupling-config.js");

const WORK_ROOT_PREFIX = "/work/";

function readTextFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return "";
	}

	return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function readCargoCouplingRunEntries(entriesDir) {
	if (!fs.existsSync(entriesDir)) {
		return [];
	}

	return fs
		.readdirSync(entriesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((entryName) => {
			const entryDir = path.join(entriesDir, entryName);
			return {
				analysis_path: readTextFile(
					path.join(entryDir, "analysis_path.txt"),
				).trim(),
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

function normalizeCargoCouplingRun(run, config) {
	const exitCode = normalizeExitCode(run?.exit_code);
	const stdout = String(run?.stdout || "").trim();
	const stderr = String(run?.stderr || "").trim();
	const json_output = normalizeCargoCouplingJsonOutput(parseJsonOutput(stdout));
	const normalized = {
		analysis_path: String(run?.analysis_path || "").trim(),
		command: String(run?.command || "").trim(),
		exit_code: exitCode,
		manifest_path: String(run?.manifest_path || "").trim(),
	};

	if (json_output !== null) {
		normalized.json_output = json_output;
		try {
			normalized.check_result = evaluateCargoCouplingCheck({
				config,
				jsonOutput: json_output,
			});
		} catch (error) {
			normalized.json_error =
				error instanceof Error ? error.message : String(error);
		}
	}

	if (stderr.length > 0) {
		normalized.stderr = stderr;
	}

	if (stdout.length > 0 && (json_output === null || normalized.json_error)) {
		normalized.stdout = stdout;
	}

	return normalized;
}

function parseJsonOutput(stdout) {
	if (typeof stdout !== "string" || stdout.trim().length === 0) {
		return null;
	}

	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

function normalizeCargoCouplingJsonOutput(jsonOutput) {
	if (
		!jsonOutput ||
		typeof jsonOutput !== "object" ||
		Array.isArray(jsonOutput)
	) {
		return jsonOutput;
	}

	const normalized = {
		...(Object.hasOwn(jsonOutput, "summary")
			? {
					summary: normalizeCargoCouplingSummary(jsonOutput.summary),
				}
			: {}),
		...(Array.isArray(jsonOutput.circular_dependencies)
			? {
					circular_dependencies: [...jsonOutput.circular_dependencies]
						.map((cycle) => canonicalizeCargoCouplingCycle(cycle))
						.sort(compareStringArrays),
				}
			: {}),
		...(Array.isArray(jsonOutput.hotspots)
			? {
					hotspots: [...jsonOutput.hotspots]
						.map((hotspot) => normalizeCargoCouplingHotspot(hotspot))
						.sort(compareCargoCouplingHotspots),
				}
			: {}),
		...(Array.isArray(jsonOutput.issues)
			? {
					issues: [...jsonOutput.issues]
						.map((issue) => normalizeCargoCouplingIssue(issue))
						.sort(compareCargoCouplingIssues),
				}
			: {}),
		...(Array.isArray(jsonOutput.modules)
			? {
					modules: [...jsonOutput.modules]
						.map((module) => normalizeCargoCouplingModule(module))
						.sort(compareCargoCouplingModules),
				}
			: {}),
	};

	return normalized;
}

function canonicalizeCargoCouplingCycle(cycle) {
	const entries = Array.isArray(cycle)
		? cycle.map((entry) => String(entry))
		: [];
	if (entries.length <= 1) {
		return entries;
	}

	const normalizedEntries =
		entries.length > 1 && entries[0] === entries.at(-1)
			? entries.slice(0, -1)
			: entries;
	const candidates = [];

	for (const candidate of [
		normalizedEntries,
		[...normalizedEntries].reverse(),
	]) {
		for (let index = 0; index < candidate.length; index += 1) {
			candidates.push(candidate.slice(index).concat(candidate.slice(0, index)));
		}
	}

	return candidates.sort(compareStringArrays)[0];
}

function normalizeCargoCouplingHotspot(hotspot) {
	if (!hotspot || typeof hotspot !== "object" || Array.isArray(hotspot)) {
		return hotspot;
	}

	return {
		...(Object.hasOwn(hotspot, "file_path")
			? {
					file_path: normalizeCargoCouplingPath(hotspot.file_path),
				}
			: {}),
		...(Object.hasOwn(hotspot, "in_cycle")
			? {
					in_cycle: hotspot.in_cycle,
				}
			: {}),
		...(Object.hasOwn(hotspot, "module")
			? {
					module: hotspot.module,
				}
			: {}),
		...(Object.hasOwn(hotspot, "score")
			? {
					score: hotspot.score,
				}
			: {}),
		...(Object.hasOwn(hotspot, "suggestion")
			? {
					suggestion: hotspot.suggestion,
				}
			: {}),
		...(Array.isArray(hotspot.issues)
			? {
					issues: [...hotspot.issues]
						.map((issue) => normalizeCargoCouplingHotspotIssue(issue))
						.sort(compareCargoCouplingHotspotIssues),
				}
			: {}),
	};
}

function normalizeCargoCouplingSummary(summary) {
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
		return summary;
	}

	return {
		...(Object.hasOwn(summary, "critical_issues")
			? { critical_issues: summary.critical_issues }
			: {}),
		...(Object.hasOwn(summary, "external_couplings")
			? { external_couplings: summary.external_couplings }
			: {}),
		...(Object.hasOwn(summary, "health_grade")
			? { health_grade: summary.health_grade }
			: {}),
		...(Object.hasOwn(summary, "health_score")
			? { health_score: summary.health_score }
			: {}),
		...(Object.hasOwn(summary, "high_issues")
			? { high_issues: summary.high_issues }
			: {}),
		...(Object.hasOwn(summary, "internal_couplings")
			? { internal_couplings: summary.internal_couplings }
			: {}),
		...(Object.hasOwn(summary, "medium_issues")
			? { medium_issues: summary.medium_issues }
			: {}),
		...(Object.hasOwn(summary, "total_couplings")
			? { total_couplings: summary.total_couplings }
			: {}),
		...(Object.hasOwn(summary, "total_modules")
			? { total_modules: summary.total_modules }
			: {}),
	};
}

function normalizeCargoCouplingIssue(issue) {
	if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
		return issue;
	}

	return {
		...(Object.hasOwn(issue, "balance_score")
			? { balance_score: issue.balance_score }
			: {}),
		...(Object.hasOwn(issue, "description")
			? { description: issue.description }
			: {}),
		...(Object.hasOwn(issue, "issue_type")
			? { issue_type: issue.issue_type }
			: {}),
		...(Object.hasOwn(issue, "severity") ? { severity: issue.severity } : {}),
		...(Object.hasOwn(issue, "source") ? { source: issue.source } : {}),
		...(Object.hasOwn(issue, "suggestion")
			? { suggestion: issue.suggestion }
			: {}),
		...(Object.hasOwn(issue, "target") ? { target: issue.target } : {}),
	};
}

function normalizeCargoCouplingHotspotIssue(issue) {
	if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
		return issue;
	}

	return {
		...(Object.hasOwn(issue, "description")
			? { description: issue.description }
			: {}),
		...(Object.hasOwn(issue, "issue_type")
			? { issue_type: issue.issue_type }
			: {}),
		...(Object.hasOwn(issue, "severity") ? { severity: issue.severity } : {}),
	};
}

function normalizeCargoCouplingModule(module) {
	if (!module || typeof module !== "object" || Array.isArray(module)) {
		return module;
	}

	return {
		...(Object.hasOwn(module, "balance_score")
			? { balance_score: module.balance_score }
			: {}),
		...(Object.hasOwn(module, "couplings_in")
			? { couplings_in: module.couplings_in }
			: {}),
		...(Object.hasOwn(module, "couplings_out")
			? { couplings_out: module.couplings_out }
			: {}),
		...(Object.hasOwn(module, "file_path")
			? {
					file_path: normalizeCargoCouplingPath(module.file_path),
				}
			: {}),
		...(Object.hasOwn(module, "in_cycle") ? { in_cycle: module.in_cycle } : {}),
		...(Object.hasOwn(module, "name") ? { name: module.name } : {}),
	};
}

function normalizeCargoCouplingPath(value) {
	if (typeof value !== "string") {
		return value ?? null;
	}

	return value.startsWith(WORK_ROOT_PREFIX)
		? value.slice(WORK_ROOT_PREFIX.length)
		: value;
}

function normalizeExitCode(value) {
	return Number.isInteger(value)
		? value
		: Number.parseInt(String(value || "0"), 10) || 0;
}

function buildCargoCouplingResult({
	commandExitCode = 0,
	config = {},
	entriesDir,
	runs = null,
}) {
	const resolvedConfig = normalizeCargoCouplingConfig({
		currentConfig: config,
		label: "linters.cargo-coupling",
	});
	const normalizedRuns = (runs || readCargoCouplingRunEntries(entriesDir)).map(
		(run) => normalizeCargoCouplingRun(run, resolvedConfig),
	);
	const failures = [];
	const details = normalizedRuns
		.map((run) => renderCargoCouplingRunDetails(run, resolvedConfig))
		.filter(Boolean)
		.join("\n\n")
		.trim();

	for (const run of normalizedRuns) {
		if (run.exit_code !== 0) {
			failures.push(run.command || run.manifest_path || "cargo-coupling run");
			continue;
		}

		if (!run.json_output) {
			failures.push(
				run.command || run.manifest_path || "cargo-coupling JSON output",
			);
			continue;
		}

		if (run.json_error) {
			failures.push(run.json_error);
			continue;
		}

		if (run.check_result?.passed === false) {
			failures.push(...run.check_result.failures);
		}
	}

	const exit_code =
		normalizeExitCode(commandExitCode) !== 0 || failures.length > 0 ? 1 : 0;

	return {
		cargo_coupling_runs: normalizedRuns.map((run) => ({
			...(run.analysis_path ? { analysis_path: run.analysis_path } : {}),
			command: run.command,
			...(run.check_result ? { check_result: run.check_result } : {}),
			exit_code: run.exit_code,
			...(run.json_output ? { json_output: run.json_output } : {}),
			manifest_path: run.manifest_path,
		})),
		details,
		exit_code,
	};
}

function renderCargoCouplingRunDetails(run, config) {
	const lines = [];
	if (run.command) {
		lines.push(`==> ${run.command}`);
	}

	if (run.json_error) {
		lines.push(`Invalid cargo-coupling JSON: ${run.json_error}`);
	}

	if (run.json_output && !run.json_error) {
		lines.push(...formatCargoCouplingSummary(run, config));
		lines.push(...formatCargoCouplingIssues(run.json_output));
		lines.push(...formatCircularDependencies(run.json_output));
	}

	if ((!run.json_output || run.json_error) && run.stdout) {
		lines.push(run.stdout);
	}

	if (run.stderr) {
		lines.push(run.stderr);
	}

	return lines.filter((line) => String(line).trim().length > 0).join("\n");
}

function formatCargoCouplingSummary(run, config) {
	const summary =
		run.json_output && typeof run.json_output.summary === "object"
			? run.json_output.summary
			: {};
	const checkResult =
		run.check_result ||
		evaluateCargoCouplingCheck({
			config,
			jsonOutput: run.json_output,
		});

	return [
		[
			`Grade: ${checkResult.grade}`,
			`Score: ${(checkResult.score * 100).toFixed(0)}%`,
			checkResult.passed ? "Quality gate: PASSED" : "Quality gate: FAILED",
		].join(" | "),
		[
			`Thresholds: min_grade=${config.min_grade}`,
			`max_critical=${config.max_critical}`,
			`max_circular=${config.max_circular}`,
		].join(", "),
		[
			`Modules: ${normalizeCount(summary.total_modules)}`,
			`Couplings: ${normalizeCount(summary.total_couplings)}`,
			`Critical: ${checkResult.critical_count}`,
			`High: ${checkResult.high_count}`,
			`Medium: ${checkResult.medium_count}`,
			`Circular: ${checkResult.circular_count}`,
		].join(" | "),
		...(checkResult.failures.length > 0
			? [
					"Blocking issues:",
					...checkResult.failures.map((failure) => ` - ${failure}`),
				]
			: []),
	];
}

function formatCargoCouplingIssues(jsonOutput) {
	const issues = Array.isArray(jsonOutput?.issues) ? jsonOutput.issues : [];
	if (issues.length === 0) {
		return [];
	}

	const modulePaths = buildModulePathMap(jsonOutput.modules);
	return [
		"Issues:",
		...issues.flatMap((issue) => {
			const severity = String(issue?.severity || "unknown").toLowerCase();
			const source = String(issue?.source || "").trim();
			const target = String(issue?.target || "").trim();
			const description = String(
				issue?.description || "cargo-coupling reported an issue",
			);
			const issueType =
				typeof issue?.issue_type === "string" &&
				issue.issue_type.trim().length > 0
					? issue.issue_type.trim()
					: "Diagnostic";
			const location = modulePaths.get(source) || modulePaths.get(target) || "";
			const subject = [source, target].filter(Boolean).join(" -> ");
			const headline = `${severity}[${issueType}]: ${description}`;
			return [
				location.length > 0
					? `${location}: ${subject.length > 0 ? `${subject}: ` : ""}${headline}`
					: subject.length > 0
						? `${subject}: ${headline}`
						: headline,
				...(typeof issue?.suggestion === "string" &&
				issue.suggestion.trim().length > 0
					? [` suggestion: ${issue.suggestion.trim()}`]
					: []),
			];
		}),
	];
}

function formatCircularDependencies(jsonOutput) {
	const cycles = Array.isArray(jsonOutput?.circular_dependencies)
		? jsonOutput.circular_dependencies
		: [];
	if (cycles.length === 0) {
		return [];
	}

	return [
		"Circular dependencies:",
		...cycles.map(
			(cycle) => ` - ${cycle.map((entry) => String(entry)).join(" -> ")}`,
		),
	];
}

function buildModulePathMap(modules) {
	const entries = Array.isArray(modules) ? modules : [];
	return new Map(
		entries
			.filter(
				(entry) =>
					entry &&
					typeof entry.name === "string" &&
					typeof entry.file_path === "string" &&
					entry.file_path.length > 0,
			)
			.map((entry) => [entry.name, entry.file_path]),
	);
}

function normalizeCount(value) {
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function compareCargoCouplingModules(left, right) {
	return (
		compareStrings(left?.file_path, right?.file_path) ||
		compareStrings(left?.name, right?.name)
	);
}

function compareCargoCouplingIssues(left, right) {
	return (
		compareStrings(left?.source, right?.source) ||
		compareStrings(left?.target, right?.target) ||
		compareStrings(left?.issue_type, right?.issue_type) ||
		compareStrings(left?.severity, right?.severity) ||
		compareStrings(left?.description, right?.description)
	);
}

function compareCargoCouplingHotspots(left, right) {
	return (
		compareStrings(left?.module, right?.module) ||
		compareNumbers(left?.score, right?.score) ||
		compareStrings(left?.suggestion, right?.suggestion)
	);
}

function compareCargoCouplingHotspotIssues(left, right) {
	return (
		compareStrings(left?.severity, right?.severity) ||
		compareStrings(left?.issue_type, right?.issue_type) ||
		compareStrings(left?.description, right?.description)
	);
}

function compareStringArrays(left, right) {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const comparison = compareStrings(left[index], right[index]);
		if (comparison !== 0) {
			return comparison;
		}
	}

	return left.length - right.length;
}

function compareStrings(left, right) {
	return String(left || "").localeCompare(String(right || ""));
}

function compareNumbers(left, right) {
	return Number(left || 0) - Number(right || 0);
}

if (require.main === module) {
	const [entriesDir, configPath, commandExitCode] = process.argv.slice(2);
	if (!entriesDir || !configPath) {
		throw new Error(
			"usage: cargo-coupling-result.js <entries-dir> <config-path> [command-exit-code]",
		);
	}

	process.stdout.write(
		`${JSON.stringify(
			buildCargoCouplingResult({
				commandExitCode,
				config: readJsonFile(configPath) || {},
				entriesDir,
			}),
		)}\n`,
	);
}

module.exports = {
	buildCargoCouplingResult,
	readCargoCouplingRunEntries,
};
