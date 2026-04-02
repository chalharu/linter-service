const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
	runOutcome,
	selectedFilesPath,
	selectOutcome,
	sourceRepositoryPath,
}) {
	const linterConfig = readLinterConfig(configPath, linterName);
	const sarifConfig = readSarifConfig(linterConfig);
	const selectedFiles = readSelectedFiles(selectedFilesPath);
	const result = readResult(resultPath);

	if (!sarifConfig || selectedFiles.length === 0) {
		return { outputPath, produced: false, sarif: null };
	}

	if (
		[selectOutcome, installOutcome, runOutcome].includes("failure") ||
		!result ||
		!Number.isInteger(result.exit_code)
	) {
		return { outputPath, produced: false, sarif: null };
	}

	const targetPaths = collectSarifTargetPaths({
		linterName,
		sarifConfig,
		selectedFiles,
		sourceRepositoryPath,
	});
	const details = resolveDiagnosticDetails(
		result,
		linterConfig.details_fallback,
	);
	const results =
		result.exit_code === 0
			? []
			: buildSarifResults({
					defaultLevel: sarifConfig.default_level || "warning",
					details,
					linterName,
					sourceRepositoryPath,
					targetPaths,
				});
	const rules = buildRuleDescriptors(results);
	const category = sarifConfig.category || `linter-service/${linterName}`;
	const toolName = sarifConfig.tool_name || `linter-service/${linterName}`;

	return {
		outputPath,
		produced: true,
		sarif: {
			$schema: "https://json.schemastore.org/sarif-2.1.0.json",
			version: "2.1.0",
			runs: [
				{
					automationDetails: {
						id: category,
					},
					results,
					tool: {
						driver: {
							informationUri: "https://github.com/chalharu/linter-service",
							name: toolName,
							rules,
						},
					},
				},
			],
		},
	};
}

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

function readLinterConfig(configPath, linterName) {
	const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const linters = Array.isArray(configData.linters) ? configData.linters : [];
	const config = linters.find(
		(item) => item && typeof item.name === "string" && item.name === linterName,
	);

	if (!config) {
		throw new Error(`unsupported linter: ${linterName}`);
	}

	return config;
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

function readSelectedFiles(selectedFilesPath) {
	if (!fs.existsSync(selectedFilesPath)) {
		return [];
	}

	return fs
		.readFileSync(selectedFilesPath, "utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function readResult(resultPath) {
	if (!fs.existsSync(resultPath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(resultPath, "utf8"));
	} catch {
		return null;
	}
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

function collectSarifTargetPaths({
	linterName,
	sarifConfig,
	selectedFiles,
	sourceRepositoryPath,
}) {
	if (sarifConfig.target_kind === "cargo-projects") {
		const projects = collectProjectTargets(
			linterName,
			sourceRepositoryPath,
			selectedFiles,
		);
		return projects.length > 0 ? projects : selectedFiles;
	}

	return selectedFiles;
}

function buildSarifResults({
	defaultLevel,
	details,
	linterName,
	sourceRepositoryPath,
	targetPaths,
}) {
	const preciseResults = dedupeResults([
		...parsePathDiagnostics({
			defaultLevel,
			details,
			linterName,
			sourceRepositoryPath,
			targetPaths,
		}),
		...parseRustStyleDiagnostics({
			defaultLevel,
			details,
			linterName,
			sourceRepositoryPath,
			targetPaths,
		}),
		...parseShellcheckStyleDiagnostics({
			defaultLevel,
			details,
			linterName,
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
		sourceRepositoryPath,
		targetPaths,
	});
}

function parsePathDiagnostics({
	defaultLevel,
	details,
	linterName,
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

			if (!match || !match.groups) {
				continue;
			}

			const filePath = normalizeReportedPath(
				sourceRepositoryPath,
				match.groups.path,
				targetPaths,
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
	sourceRepositoryPath,
	targetPaths,
}) {
	let currentMessage = "";
	const results = [];

	for (const rawLine of details.split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (/^(error|warning|note)(\[[^\]]+\])?:/iu.test(line)) {
			currentMessage = line.replace(
				/^(error|warning|note)(\[[^\]]+\])?:\s*/iu,
				"",
			);
			continue;
		}

		const match = /^\s*-->\s+(?<path>.+?):(?<line>\d+):(?<column>\d+)/u.exec(
			rawLine,
		);

		if (!match || !match.groups) {
			continue;
		}

		const filePath = normalizeReportedPath(
			sourceRepositoryPath,
			match.groups.path,
			targetPaths,
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
				message: currentMessage || summarizeDetails(details, linterName),
				ruleId:
					extractRuleId(currentMessage, linterName) ||
					`${linterName}/diagnostic`,
			}),
		);
	}

	return results;
}

function parseShellcheckStyleDiagnostics({
	defaultLevel,
	details,
	linterName,
	sourceRepositoryPath,
	targetPaths,
}) {
	const lines = details.split(/\r?\n/u);
	const results = [];

	for (let index = 0; index < lines.length; index += 1) {
		const match = /^In (?<path>.+?) line (?<line>\d+):$/u.exec(
			lines[index].trim(),
		);

		if (!match || !match.groups) {
			continue;
		}

		const filePath = normalizeReportedPath(
			sourceRepositoryPath,
			match.groups.path,
			targetPaths,
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
	sourceRepositoryPath,
	targetPaths,
}) {
	const summaryMessage = summarizeDetails(details, linterName);
	const mentionedPaths = targetPaths.filter((targetPath) =>
		details.includes(targetPath),
	);
	const fallbackPaths =
		mentionedPaths.length > 0
			? mentionedPaths
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
					normalizeReportedPath(sourceRepositoryPath, filePath, targetPaths),
				linterName,
				message: summaryMessage,
				ruleId:
					extractRuleId(details, linterName) || `${linterName}/diagnostic`,
			}),
		);
	}

	return dedupeResults(results);
}

function createResult({
	column,
	defaultLevel,
	filePath,
	line,
	linterName,
	message,
	ruleId,
}) {
	const sanitizedMessage = truncate(message, 1000);
	const result = {
		level: toSarifLevel(sanitizedMessage, defaultLevel),
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

function parseInteger(value) {
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractRuleId(text, linterName) {
	if (typeof text !== "string") {
		return null;
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
	if (/fatal|error|failed/iu.test(text)) {
		return "error";
	}

	if (/warn|warning/iu.test(text)) {
		return "warning";
	}

	if (/note|info/iu.test(text)) {
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
) {
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
		const relative = path.relative(
			path.resolve(sourceRepositoryPath),
			reportedPath,
		);

		if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
			return normalizePath(relative);
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
