const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const requireEnv = require("./lib/require-env.js");
const { buildSarifEnvelope } = require("./lib/sarif.js");
const {
	readLinterConfig,
	readResult,
	readSelectedFiles,
	readTargetKind,
} = require("./lib/linter-shared.js");

const {
	buildSarifResults: buildCargoDenySarifResults,
} = require("../../cargo-deny/render-linter-sarif.js");
const { collectProjectTargets } = require("./render-linter-report.js");

const DETAILS_LIMIT = 8000;
const MAX_FALLBACK_RESULTS = 25;
const RULE_ID_PATTERN = /\b[A-Z][A-Z0-9_-]{1,15}\d{1,5}\b/u;

function runFromEnv(env = process.env) {
	const linterName = requireEnv(env, "LINTER_NAME");
	const runnerTemp = requireEnv(env, "RUNNER_TEMP");
	const report = renderSarif({
		configPath: requireEnv(env, "LINTER_CONFIG_PATH"),
		installOutcome: env.INSTALL_TOOL_OUTCOME ?? "",
		linterName,
		outputPath:
			env.OUTPUT_PATH ||
			path.join(runnerTemp, `linter-sarif-${linterName}.sarif`),
		resultPath: requireEnv(env, "RESULT_PATH"),
		runnerTemp,
		runOutcome: env.RUN_LINTER_OUTCOME ?? "",
		selectedFilesPath: requireEnv(env, "SELECTED_FILES_PATH"),
		selectOutcome: env.SELECT_FILES_OUTCOME ?? "",
		sourceRepositoryPath: requireEnv(env, "SOURCE_REPOSITORY_PATH"),
	});

	if (report.produced) {
		fs.writeFileSync(
			report.outputPath,
			JSON.stringify(report.sarif, null, 2),
			"utf8",
		);
	}

	return report;
}

function renderSarif({
	configPath,
	installOutcome,
	linterName,
	outputPath,
	resultPath,
	runnerTemp,
	runOutcome,
	selectedFilesPath,
	selectOutcome,
	sourceRepositoryPath,
}) {
	const linterConfig = readLinterConfig(configPath, linterName);
	const sarifConfig = readSarifConfig(linterConfig);
	const targetKind = readTargetKind(linterConfig);
	const selectedFiles = readSelectedFiles(selectedFilesPath);
	const result = readResult(resultPath);
	const targetPaths = collectSarifTargetPaths({
		linterName,
		selectedFiles,
		sourceRepositoryPath,
		targetKind,
	});

	if (selectedFiles.length === 0) {
		return {
			outputPath,
			produced: false,
			sarif: null,
			targetStats: buildTargetStats({
				results: [],
				targetKind,
				targetPaths,
			}),
		};
	}

	if (
		[selectOutcome, installOutcome, runOutcome].includes("failure") ||
		!result ||
		!Number.isInteger(result.exit_code)
	) {
		return {
			outputPath,
			produced: false,
			sarif: null,
			targetStats: buildUnknownTargetStats({
				targetKind,
				targetPaths,
			}),
		};
	}

	const details = resolveDiagnosticDetails(
		result,
		buildDetailsFallback(linterName),
	);
	const reportedPathRoots = buildReportedPathRoots({
		linterName,
		runnerTemp,
		sourceRepositoryPath,
	});
	const results =
		result.exit_code === 0
			? []
			: buildSarifResults({
					result,
					defaultLevel: sarifConfig?.default_level || "warning",
					details,
					linterName,
					reportedPathRoots,
					sourceRepositoryPath,
					targetPaths,
				});
	const targetStats = buildTargetStats({
		results,
		targetKind,
		targetPaths,
	});

	if (!sarifConfig) {
		return { outputPath, produced: false, sarif: null, targetStats };
	}

	const rules = buildRuleDescriptors(results);
	const category = sarifConfig.category || `linter-service/${linterName}`;
	const toolName = sarifConfig.tool_name || `linter-service/${linterName}`;

	return {
		outputPath,
		produced: true,
		sarif: buildSarifEnvelope({ category, results, rules, toolName }),
		targetStats,
	};
}

function readSarifConfig(linterConfig) {
	if (!linterConfig || typeof linterConfig !== "object") {
		return null;
	}

	if (!linterConfig.sarif || typeof linterConfig.sarif !== "object") {
		return null;
	}

	return linterConfig.sarif.enabled === true ? linterConfig.sarif : null;
}

function resolveDiagnosticDetails(result, fallback) {
	const details =
		result && typeof result.details === "string" ? result.details.trim() : "";
	const exitCode =
		result && Number.isInteger(result.exit_code) ? result.exit_code : 0;

	if (details.length > 0) {
		return details.slice(0, DETAILS_LIMIT);
	}

	return exitCode === 0 ? "" : fallback;
}

function buildDetailsFallback(linterName) {
	return `The \`${linterName}\` run exited with issues but did not produce diagnostic output.`;
}

function collectSarifTargetPaths({
	linterName,
	selectedFiles,
	sourceRepositoryPath,
	targetKind,
}) {
	if (targetKind === "cargo-project") {
		const projects = collectProjectTargets(
			linterName,
			sourceRepositoryPath,
			selectedFiles,
		);
		return projects.length > 0 ? projects : selectedFiles;
	}

	return selectedFiles;
}

function buildTargetStats({ results, targetKind, targetPaths }) {
	const targetCount = targetPaths.length;
	const issueTargetCount = countIssueTargets(results, targetPaths);

	return {
		counts_known: true,
		issue_count: results.length,
		issue_target_count: issueTargetCount,
		passed_target_count:
			issueTargetCount === null
				? null
				: Math.max(targetCount - issueTargetCount, 0),
		target_count: targetCount,
		target_kind: targetKind,
	};
}

function buildUnknownTargetStats({ targetKind, targetPaths }) {
	return {
		counts_known: false,
		issue_count: null,
		issue_target_count: null,
		passed_target_count: null,
		target_count: targetPaths.length,
		target_kind: targetKind,
	};
}

function countIssueTargets(results, targetPaths) {
	if (!Array.isArray(results) || results.length === 0) {
		return 0;
	}

	const locations = new Set(
		results
			.map(
				(result) =>
					result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri || "",
			)
			.filter(Boolean),
	);

	if (locations.size > 0) {
		return targetPaths.length > 0
			? Math.min(locations.size, targetPaths.length)
			: locations.size;
	}

	if (targetPaths.length > 0) {
		return 1;
	}

	return null;
}

function buildReportedPathRoots({
	linterName,
	runnerTemp,
	sourceRepositoryPath,
}) {
	const roots = [path.resolve(sourceRepositoryPath)];

	if (typeof runnerTemp === "string" && runnerTemp.length > 0) {
		roots.push(path.resolve(runnerTemp, `${linterName}-workspace/source`));
	}

	return [...new Set(roots)];
}

function buildSarifResults({
	defaultLevel,
	details,
	linterName,
	result,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const linterSpecificResults = buildLinterSpecificSarifResults({
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
	});

	if (linterSpecificResults.length > 0) {
		return linterSpecificResults;
	}

	const preciseResults = dedupeResults([
		...parsePathDiagnostics({
			defaultLevel,
			details,
			linterName,
			reportedPathRoots,
			sourceRepositoryPath,
			targetPaths,
		}),
		...parseRustStyleDiagnostics({
			defaultLevel,
			details,
			linterName,
			reportedPathRoots,
			sourceRepositoryPath,
			targetPaths,
		}),
		...parseSnippetStyleDiagnostics({
			defaultLevel,
			details,
			linterName,
			reportedPathRoots,
			sourceRepositoryPath,
			targetPaths,
		}),
		...parseShellcheckStyleDiagnostics({
			defaultLevel,
			details,
			linterName,
			reportedPathRoots,
			sourceRepositoryPath,
			targetPaths,
		}),
	]);

	if (preciseResults.length > 0) {
		return preciseResults;
	}

	return buildFallbackResults({
		defaultLevel,
		details,
		linterName,
		reportedPathRoots,
		sourceRepositoryPath,
		targetPaths,
	});
}

function buildLinterSpecificSarifResults({
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
	if (linterName === "cargo-deny") {
		return buildCargoDenySarifResults({
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
		});
	}

	if (linterName === "helmlint") {
		return buildHelmLintSarifResults({
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
		});
	}

	return [];
}

function buildHelmLintSarifResults({
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

function parsePathDiagnostics({
	defaultLevel,
	details,
	linterName,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const patterns = [
		/^(?<path>.+?):(?<line>\d+):(?<column>\d+):\s*(?<message>.+)$/u,
		/^(?<path>.+?):(?<line>\d+)\s+(?<rule>[A-Z][A-Z0-9_-]{1,15}\d{1,5})\s+(?<message>.+)$/u,
		/^(?<path>.+?):(?<line>\d+):\s*(?<message>.+)$/u,
	];
	const results = [];

	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (line.length === 0 || line.startsWith("==>") || line.startsWith("-->")) {
			continue;
		}

		for (const pattern of patterns) {
			const match = pattern.exec(line);

			if (!match?.groups) {
				continue;
			}

			const filePath = normalizeReportedPath(
				sourceRepositoryPath,
				match.groups.path,
				targetPaths,
				reportedPathRoots,
			);

			if (!filePath) {
				continue;
			}

			results.push(
				createResult({
					column: parseInteger(match.groups.column),
					defaultLevel,
					filePath,
					line: parseInteger(match.groups.line),
					linterName,
					message: match.groups.message.trim(),
					ruleId:
						match.groups.rule ||
						extractRuleId(match.groups.message, linterName) ||
						`${linterName}/diagnostic`,
				}),
			);
			break;
		}
	}

	return results;
}

function parseRustStyleDiagnostics({
	defaultLevel,
	details,
	linterName,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	let currentMessage = "";
	let currentRuleId = null;
	let emittedForCurrentDiagnostic = false;
	const results = [];

	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		const header = parseDiagnosticHeader(line);

		if (header) {
			if (header.kind === "note") {
				continue;
			}

			currentMessage = header.message;
			currentRuleId = header.ruleId;
			emittedForCurrentDiagnostic = false;
			continue;
		}

		const match = /^\s*-->\s+(?<path>.+?):(?<line>\d+):(?<column>\d+)/u.exec(
			rawLine,
		);

		if (!match?.groups || emittedForCurrentDiagnostic) {
			continue;
		}

		const filePath = normalizeReportedPath(
			sourceRepositoryPath,
			match.groups.path,
			targetPaths,
			reportedPathRoots,
		);

		if (!filePath) {
			continue;
		}

		emittedForCurrentDiagnostic = true;
		results.push(
			createResult({
				column: parseInteger(match.groups.column),
				defaultLevel,
				filePath,
				line: parseInteger(match.groups.line),
				linterName,
				message: currentMessage || summarizeDetails(details, linterName),
				ruleId: resolveDiagnosticRuleId(
					currentRuleId,
					currentMessage,
					linterName,
				),
			}),
		);
	}

	return results;
}

function parseSnippetStyleDiagnostics({
	defaultLevel,
	details,
	linterName,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	let currentMessage = "";
	let currentRuleId = null;
	let emittedForCurrentDiagnostic = false;
	const results = [];

	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		const header = parseDiagnosticHeader(line);

		if (header) {
			if (header.kind === "note") {
				continue;
			}

			currentMessage = header.message;
			currentRuleId = header.ruleId;
			emittedForCurrentDiagnostic = false;
			continue;
		}

		const match =
			/^\s*[│|]?\s*[┌╭]─\s+(?<path>.+?):(?<line>\d+):(?<column>\d+)/u.exec(
				rawLine,
			);

		if (!match?.groups || emittedForCurrentDiagnostic) {
			continue;
		}

		const filePath = normalizeReportedPath(
			sourceRepositoryPath,
			match.groups.path,
			targetPaths,
			reportedPathRoots,
		);

		if (!filePath) {
			continue;
		}

		emittedForCurrentDiagnostic = true;
		results.push(
			createResult({
				column: parseInteger(match.groups.column),
				defaultLevel,
				filePath,
				line: parseInteger(match.groups.line),
				linterName,
				message: currentMessage || summarizeDetails(details, linterName),
				ruleId: resolveDiagnosticRuleId(
					currentRuleId,
					currentMessage,
					linterName,
				),
			}),
		);
	}

	return results;
}

function parseShellcheckStyleDiagnostics({
	defaultLevel,
	details,
	linterName,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const lines = details.split(/\r?\n/u);
	const results = [];

	for (let index = 0; index < lines.length; index += 1) {
		const match = /^In (?<path>.+?) line (?<line>\d+):$/u.exec(
			lines[index].trim(),
		);

		if (!match?.groups) {
			continue;
		}

		const filePath = normalizeReportedPath(
			sourceRepositoryPath,
			match.groups.path,
			targetPaths,
			reportedPathRoots,
		);

		if (!filePath) {
			continue;
		}

		const blockLines = lines
			.slice(index + 1, index + 6)
			.map((line) => line.trim());
		const diagnosticLine = blockLines.find((line) =>
			RULE_ID_PATTERN.test(line),
		);
		const message =
			diagnosticLine?.replace(/^[\^~-]+\s*/u, "").trim() ||
			blockLines.find(
				(line) =>
					line.length > 0 &&
					!/^[\^~-]+$/u.test(line) &&
					!line.startsWith("For more information:"),
			) ||
			summarizeDetails(details, linterName);
		const ruleId =
			extractRuleId(blockLines.join(" "), linterName) ||
			`${linterName}/diagnostic`;

		results.push(
			createResult({
				defaultLevel,
				filePath,
				line: parseInteger(match.groups.line),
				linterName,
				message,
				ruleId,
			}),
		);
	}

	return results;
}

function buildFallbackResults({
	defaultLevel,
	details,
	linterName,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const summaryMessage = summarizeDetails(details, linterName);
	const collectedFallbackPaths = collectFallbackPaths({
		details,
		linterName,
		targetPaths,
	});
	const fallbackPaths =
		collectedFallbackPaths.length > 0
			? collectedFallbackPaths
			: targetPaths.length > 0
				? targetPaths
				: [null];
	const results = [];

	for (const filePath of fallbackPaths.slice(0, MAX_FALLBACK_RESULTS)) {
		results.push(
			createResult({
				defaultLevel,
				filePath:
					filePath &&
					normalizeReportedPath(
						sourceRepositoryPath,
						filePath,
						targetPaths,
						reportedPathRoots,
					),
				linterName,
				message: summaryMessage,
				ruleId:
					extractRuleId(details, linterName) || `${linterName}/diagnostic`,
			}),
		);
	}

	return dedupeResults(results);
}

function collectFallbackPaths({ details, linterName, targetPaths }) {
	const explicitPaths = extractFallbackPaths({
		details,
		linterName,
		targetPaths,
	});

	if (explicitPaths.length > 0) {
		return explicitPaths;
	}

	return targetPaths.filter((targetPath) => details.includes(targetPath));
}

function extractFallbackPaths({ details, linterName, targetPaths }) {
	if (linterName !== "rustfmt") {
		return [];
	}

	const targetSet = new Set(targetPaths);
	const fallbackPaths = [];

	for (const match of details.matchAll(
		/^Diff in (?<filePath>.+?)(?::\d+| at line \d+):\s*$/gmu,
	)) {
		const filePath = match.groups?.filePath;
		if (
			!filePath ||
			!targetSet.has(filePath) ||
			fallbackPaths.includes(filePath)
		) {
			continue;
		}

		fallbackPaths.push(filePath);
	}

	return fallbackPaths;
}

function createResult({
	column,
	defaultLevel,
	filePath,
	line,
	level,
	linterName,
	message,
	ruleId,
}) {
	const sanitizedMessage = truncate(message, 1000);
	const result = {
		level:
			typeof level === "string" && level.length > 0
				? level
				: toSarifLevel(sanitizedMessage, defaultLevel),
		message: {
			text: sanitizedMessage,
		},
		partialFingerprints: buildPartialFingerprints({
			column,
			filePath,
			line,
			message: sanitizedMessage,
			ruleId,
		}),
		ruleId,
	};

	if (filePath) {
		result.locations = [
			{
				physicalLocation: {
					artifactLocation: {
						uri: filePath,
					},
					...(line
						? {
								region: {
									startColumn: column || 1,
									startLine: line,
								},
							}
						: {}),
				},
			},
		];
	}

	result.properties = {
		linter_name: linterName,
	};

	return result;
}

function buildPartialFingerprints({ column, filePath, line, message, ruleId }) {
	const fingerprint = crypto
		.createHash("sha256")
		.update(
			[
				ruleId,
				filePath || "<no-location>",
				String(line || 0),
				String(column || 0),
				message,
			].join("|"),
		)
		.digest("hex");

	return {
		primaryLocationLineHash: fingerprint,
	};
}

function dedupeResults(results) {
	const seen = new Set();
	const deduped = [];

	for (const result of results) {
		const location = result.locations?.[0]?.physicalLocation;
		const region = location?.region;
		const key = [
			result.ruleId,
			location?.artifactLocation?.uri || "",
			String(region?.startLine || 0),
			String(region?.startColumn || 0),
			result.message?.text || "",
		].join("|");

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		deduped.push(result);
	}

	return deduped;
}

function buildRuleDescriptors(results) {
	const ruleIds = [
		...new Set(results.map((result) => result.ruleId).filter(Boolean)),
	];

	return ruleIds.map((ruleId) => ({
		id: ruleId,
		name: ruleId,
		shortDescription: {
			text: ruleId,
		},
	}));
}

function parseDiagnosticHeader(rawLine) {
	const match =
		/^(?<kind>error|warning|note)(?:\[(?<ruleId>[^\]]+)\])?:\s*(?<message>.*)$/iu.exec(
			String(rawLine || "").trim(),
		);

	if (!match?.groups) {
		return null;
	}

	return {
		kind: match.groups.kind.toLowerCase(),
		message: match.groups.message.trim(),
		ruleId: match.groups.ruleId ? match.groups.ruleId.trim() : null,
	};
}

function parseInteger(value) {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? value : null;
	}

	if (typeof value !== "string" || value.length === 0) {
		return null;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveDiagnosticRuleId(headerRuleId, text, linterName) {
	if (typeof headerRuleId === "string" && headerRuleId.trim().length > 0) {
		return headerRuleId.trim();
	}

	return extractRuleId(text, linterName) || `${linterName}/diagnostic`;
}

function extractRuleId(text, linterName) {
	if (typeof text !== "string") {
		return null;
	}

	const headerMatch =
		/(?:^|\b)(?:error|warning|note)\[(?<ruleId>[^\]]+)\]:/iu.exec(text);

	if (headerMatch?.groups?.ruleId) {
		return headerMatch.groups.ruleId.trim();
	}

	const match = text.match(RULE_ID_PATTERN);
	return match ? match[0] : `${linterName}/diagnostic`;
}

function summarizeDetails(details, linterName) {
	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (
			line.length === 0 ||
			line.startsWith("==>") ||
			line.startsWith("-->") ||
			line.startsWith("|") ||
			/^[\^~-]+$/u.test(line) ||
			line.startsWith("For more information:")
		) {
			continue;
		}

		return truncate(line, 1000);
	}

	return `${linterName} reported issues.`;
}

function toSarifLevel(text, defaultLevel) {
	if (/\b(?:fatal|error|failed)\b/iu.test(text)) {
		return "error";
	}

	if (/\b(?:warn|warning)\b/iu.test(text)) {
		return "warning";
	}

	if (/\b(?:note|info)\b/iu.test(text)) {
		return "note";
	}

	return defaultLevel;
}

function truncate(text, maxLength) {
	if (text.length <= maxLength) {
		return text;
	}

	return `${text.slice(0, maxLength - 16)}... truncated ...`;
}

function normalizeReportedPath(
	sourceRepositoryPath,
	reportedPath,
	targetPaths,
	reportedPathRoots = [],
) {
	const absolutePathRoots =
		reportedPathRoots.length > 0
			? reportedPathRoots
			: [path.resolve(sourceRepositoryPath)];
	const normalized = normalizePath(String(reportedPath || "").trim()).replace(
		/^\.\//u,
		"",
	);

	if (normalized.length === 0) {
		return null;
	}

	const candidatePaths = [...targetPaths].sort(
		(left, right) => right.length - left.length,
	);
	for (const candidate of candidatePaths) {
		if (normalized === candidate || normalized.endsWith(`/${candidate}`)) {
			return candidate;
		}
	}

	if (path.isAbsolute(reportedPath)) {
		for (const rootPath of absolutePathRoots) {
			const relative = path.relative(rootPath, reportedPath);
			const repoResolved = path.resolve(sourceRepositoryPath, relative);

			if (
				!relative.startsWith("..") &&
				!path.isAbsolute(relative) &&
				fs.existsSync(repoResolved)
			) {
				return normalizePath(relative);
			}
		}
	}

	const resolved = path.resolve(sourceRepositoryPath, normalized);
	const relative = path.relative(path.resolve(sourceRepositoryPath), resolved);

	if (
		!relative.startsWith("..") &&
		!path.isAbsolute(relative) &&
		fs.existsSync(resolved)
	) {
		return normalizePath(relative);
	}

	return null;
}

function normalizePath(filePath) {
	return String(filePath || "").replace(/\\/gu, "/");
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	buildSarifResults,
	collectSarifTargetPaths,
	createResult,
	dedupeResults,
	normalizeReportedPath,
	renderSarif,
	runFromEnv,
};
