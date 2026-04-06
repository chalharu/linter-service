const fs = require("node:fs");
const path = require("node:path");
const requireEnv = require("./lib/require-env.js");
const { loadLinterHook } = require("./lib/linter-hooks.js");
const {
	deriveTargetCount,
	escapeHtml,
	formatTargetLabel,
	normalizeOptionalCount,
	normalizeStringArray,
	readLinterConfig,
	readResult,
	readSelectedFiles,
	readTargetKind,
} = require("./lib/linter-shared.js");

const MAX_INLINE_PATHS = 10;
const MAX_RENDERED_PATHS = 100;
const DETAILS_LIMIT = 60000;

function runFromEnv(env = process.env) {
	const linterName = requireEnv(env, "LINTER_NAME");
	const runnerTemp = requireEnv(env, "RUNNER_TEMP");
	const report = renderReport({
		configPath: requireEnv(env, "LINTER_CONFIG_PATH"),
		exitCodeRaw: env.EXIT_CODE ?? "",
		installOutcome: env.INSTALL_TOOL_OUTCOME ?? "",
		linterName,
		resultPath: requireEnv(env, "RESULT_PATH"),
		runOutcome: env.RUN_LINTER_OUTCOME ?? "",
		selectedFilesPath: requireEnv(env, "SELECTED_FILES_PATH"),
		selectOutcome: env.SELECT_FILES_OUTCOME ?? "",
		sourceRepositoryPath: requireEnv(env, "SOURCE_REPOSITORY_PATH"),
	});

	writeReportFiles({
		linterName,
		report,
		runnerTemp,
	});

	return report;
}

function renderReport({
	configPath,
	exitCodeRaw,
	installOutcome,
	linterName,
	resultPath,
	runOutcome,
	selectedFilesPath,
	selectOutcome,
	sourceRepositoryPath,
	targetStats,
}) {
	const linterConfig = readLinterConfig(configPath, linterName);
	const selectedFiles = readSelectedFiles(selectedFilesPath);
	const checkedProjects = collectProjectTargets({
		configPath,
		linterName,
		sourceRepositoryPath,
		selectedFiles,
	});
	const targetLines = buildTargetLines(selectedFiles, checkedProjects);
	const result = readResult(resultPath);
	const hasStepFailure = [selectOutcome, installOutcome, runOutcome].includes(
		"failure",
	);
	const success =
		!hasStepFailure && (selectedFiles.length === 0 || exitCodeRaw === "0");
	const conclusion = success ? "success" : "failure";
	let detailsText = "";
	const status =
		hasStepFailure && result === null
			? "infra_failure"
			: selectedFiles.length === 0 && exitCodeRaw === ""
				? "no_targets"
				: success
					? "success"
					: "failure";

	if (status === "failure") {
		detailsText = resolveDetails(result, buildDetailsFallback(linterName));
	}

	const normalizedTargetStats = normalizeTargetStats({
		checkedProjects,
		linterConfig,
		selectedFiles,
		status,
		targetStats,
	});
	const summaryText = buildSummaryText({
		linterName,
		status,
		targetStats: normalizedTargetStats,
	});
	const lines = [`### ${linterName}`, "", summaryText];

	if (status !== "no_targets") {
		appendTargetLines(lines, targetLines);
	}

	if (status === "failure") {
		lines.push(
			"",
			"<details><summary>Details</summary>",
			"",
			"```text",
			detailsText,
			"```",
			"</details>",
		);
	}

	return {
		body: `${lines.join("\n")}\n`,
		checkedProjects,
		conclusion,
		detailsText,
		selectedFiles,
		status,
		summaryText,
		targetStats: normalizedTargetStats,
		targetSummary: buildTargetSummary(selectedFiles, checkedProjects),
	};
}

function resolveDetails(result, fallback) {
	const details =
		result && typeof result.details === "string" ? result.details.trim() : "";

	if (details.length === 0) {
		return fallback;
	}

	if (details.length > DETAILS_LIMIT) {
		return `${details.slice(0, DETAILS_LIMIT)}\n... truncated ...`;
	}

	return details;
}

function buildDetailsFallback(linterName) {
	return `The \`${linterName}\` run exited with issues but did not produce diagnostic output.`;
}

function buildSummaryText({ linterName, status, targetStats }) {
	switch (status) {
		case "success":
			return `✅ ${formatRatio(targetStats.passedTargetCount, targetStats.targetCount)} ${formatTargetLabel(targetStats.targetKind, targetStats.targetCount)} passed.`;
		case "no_targets":
			return `⚪ 0 ${formatTargetLabel(targetStats.targetKind, 0)} checked.`;
		case "infra_failure":
			return targetStats.targetCount === null
				? `❌ The \`${linterName}\` workflow failed before diagnostics were produced. See the workflow logs.`
				: `❌ Matched ${formatTargetQuantity(targetStats.targetCount, targetStats.targetKind)}, but the workflow failed before diagnostics were produced.`;
		case "failure":
			if (
				targetStats.countsKnown &&
				targetStats.passedTargetCount !== null &&
				targetStats.issueTargetCount !== null &&
				targetStats.targetCount !== null
			) {
				return `❌ ${formatRatio(targetStats.passedTargetCount, targetStats.targetCount)} ${formatTargetLabel(targetStats.targetKind, targetStats.targetCount)} passed; ${formatTargetQuantity(targetStats.issueTargetCount, targetStats.targetKind)} reported issues.`;
			}

			return targetStats.targetCount === null
				? `❌ The \`${linterName}\` run reported issues. See the workflow logs.`
				: `❌ Checked ${formatTargetQuantity(targetStats.targetCount, targetStats.targetKind)}; issue counts are unavailable.`;
		default:
			return `❌ The \`${linterName}\` workflow failed before producing a detailed report. See the workflow logs.`;
	}
}

function normalizeTargetStats({
	checkedProjects,
	linterConfig,
	selectedFiles,
	status,
	targetStats,
}) {
	if (targetStats && typeof targetStats === "object") {
		const targetKind =
			targetStats.target_kind === "cargo-project" ||
			targetStats.targetKind === "cargo-project"
				? "cargo-project"
				: "file";
		const targetCount = normalizeOptionalCount(
			targetStats.target_count ?? targetStats.targetCount,
		);
		const countsKnown =
			typeof targetStats.counts_known === "boolean"
				? targetStats.counts_known
				: typeof targetStats.countsKnown === "boolean"
					? targetStats.countsKnown
					: status === "success" || status === "no_targets";
		const issueTargetCount = normalizeOptionalCount(
			targetStats.issue_target_count ?? targetStats.issueTargetCount,
		);
		const passedTargetCount = normalizeOptionalCount(
			targetStats.passed_target_count ?? targetStats.passedTargetCount,
		);

		return {
			countsKnown,
			issueCount: normalizeOptionalCount(
				targetStats.issue_count ?? targetStats.issueCount,
			),
			issueTargetCount:
				countsKnown && issueTargetCount === null && status !== "infra_failure"
					? 0
					: issueTargetCount,
			passedTargetCount:
				countsKnown && passedTargetCount === null && targetCount !== null
					? targetCount
					: passedTargetCount,
			targetCount,
			targetKind,
		};
	}

	const targetKind = readTargetKind(linterConfig);
	const targetCount = deriveTargetCount({
		checkedProjects,
		selectedFiles,
		targetKind,
	});

	if (status === "success" || status === "no_targets") {
		return {
			countsKnown: true,
			issueCount: 0,
			issueTargetCount: 0,
			passedTargetCount: targetCount,
			targetCount,
			targetKind,
		};
	}

	return {
		countsKnown: false,
		issueCount: null,
		issueTargetCount: null,
		passedTargetCount: null,
		targetCount,
		targetKind,
	};
}

function formatRatio(passed, total) {
	return `${passed} / ${total}`;
}

function formatTargetQuantity(count, targetKind) {
	return `${count} ${formatTargetLabel(targetKind, count)}`;
}

function appendTargetLines(lines, targetLines) {
	if (targetLines.length === 0) {
		return;
	}

	lines.push("", ...targetLines);
}

function buildTargetLines(selectedFiles, checkedProjects) {
	const lines = [];

	if (selectedFiles.length > 0) {
		lines.push(...formatPathSection("Target file paths", selectedFiles));
	}

	if (checkedProjects.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}

		lines.push(...formatPathSection("Cargo project targets", checkedProjects));
	}

	return lines;
}

function buildTargetSummary(selectedFiles, checkedProjects) {
	const parts = [];

	if (selectedFiles.length > 0) {
		parts.push(`${selectedFiles.length} file(s)`);
	}

	if (checkedProjects.length > 0) {
		parts.push(`${checkedProjects.length} Cargo project(s)`);
	}

	return parts.length > 0 ? parts.join(", ") : "n/a";
}

function formatPathSection(title, paths) {
	const displayedPaths = paths.slice(0, MAX_RENDERED_PATHS);
	const pathLines = [];

	for (const currentPath of displayedPaths) {
		pathLines.push(`- <code>${escapeHtml(currentPath)}</code>`);
	}

	if (paths.length > displayedPaths.length) {
		pathLines.push(
			`- ... ${paths.length - displayedPaths.length} more path(s) omitted`,
		);
	}

	if (paths.length <= MAX_INLINE_PATHS) {
		return [`${title}:`, ...pathLines];
	}

	return [
		`${title}:`,
		"",
		`<details><summary>Show ${paths.length} path(s)</summary>`,
		"",
		...pathLines,
		"</details>",
	];
}

function collectProjectTargets({
	configPath,
	linterName,
	linterServicePath,
	selectedFiles,
	sourceRepositoryPath,
}) {
	const hook = loadLinterHook({
		configPath,
		fileName: "render-linter-report.js",
		linterName,
		linterServicePath,
	});

	if (typeof hook?.collectProjectTargets !== "function") {
		return [];
	}

	const projectTargets = hook.collectProjectTargets({
		selectedFiles,
		sourceRepositoryPath,
	});

	if (!Array.isArray(projectTargets)) {
		throw new Error(
			`${linterName} render-linter-report.js must return an array of project targets`,
		);
	}

	return normalizeStringArray(projectTargets);
}

function buildReportSummary({
	body,
	checkedProjects = [],
	conclusion,
	detailsText = "",
	linterName,
	selectedFiles = [],
	status,
	summaryText = "",
	targetStats,
}) {
	const normalizedTargetStats = normalizeTargetStats({
		checkedProjects,
		linterConfig: {},
		selectedFiles,
		status,
		targetStats,
	});

	return {
		checked_projects: normalizeStringArray(checkedProjects),
		checked_project_count: Array.isArray(checkedProjects)
			? checkedProjects.length
			: 0,
		comment_body: body,
		conclusion,
		details_text: detailsText,
		linter_name: linterName,
		selected_files: normalizeStringArray(selectedFiles),
		selected_file_count: Array.isArray(selectedFiles)
			? selectedFiles.length
			: 0,
		status:
			typeof status === "string" && status.length > 0
				? status
				: conclusion === "success"
					? "success"
					: "failure",
		summary_text: summaryText,
		counts_known: normalizedTargetStats.countsKnown,
		issue_count: normalizedTargetStats.issueCount,
		issue_target_count: normalizedTargetStats.issueTargetCount,
		passed_target_count: normalizedTargetStats.passedTargetCount,
		target_count: normalizedTargetStats.targetCount,
		target_kind: normalizedTargetStats.targetKind,
	};
}

function writeReportFiles({ linterName, report, runnerTemp }) {
	const commentPath = path.join(runnerTemp, "linter-comment.md");
	const summaryPath = path.join(
		runnerTemp,
		`linter-summary-${linterName}.json`,
	);

	fs.writeFileSync(commentPath, report.body, "utf8");
	fs.writeFileSync(
		summaryPath,
		JSON.stringify(buildReportSummary({ ...report, linterName }), null, 2),
		"utf8",
	);
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	buildReportSummary,
	buildTargetSummary,
	collectProjectTargets,
	renderReport,
	runFromEnv,
};
