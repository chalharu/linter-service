const fs = require("node:fs");
const path = require("node:path");

const COMMENT_MARKER = "<!-- linter-service:results -->";
const MAX_TARGET_PATHS = 50;

function runFromEnv(env = process.env) {
	const report = renderCombinedReport({
		decryptOutcome: env.DECRYPT_SUMMARIES_OUTCOME ?? "",
		selectedLinters: parseSelectedLinters(
			requireEnv(env, "SELECTED_LINTERS_JSON"),
		),
		summaryRoot: requireEnv(env, "LINTER_SUMMARY_PATH"),
	});
	const runnerTemp = requireEnv(env, "RUNNER_TEMP");

	writeCombinedReportFiles({
		checkRunText: report.checkRunText,
		commentBody: report.commentBody,
		runnerTemp,
	});

	if (typeof env.GITHUB_OUTPUT === "string" && env.GITHUB_OUTPUT.length > 0) {
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			[
				`overall_conclusion=${report.overallConclusion}`,
				`overall_summary=${report.overallSummary}`,
				"",
			].join("\n"),
			"utf8",
		);
	}

	return report;
}

function renderCombinedReport({
	decryptOutcome,
	selectedLinters,
	summaryRoot,
}) {
	const summaries = readLinterSummaries(summaryRoot);
	const rows = [];
	const detailSections = [];
	let failed = 0;

	for (const linterName of selectedLinters) {
		const summary = normalizeSummary(
			summaries.get(linterName) ??
				buildFallbackSummary({
					decryptOutcome,
					linterName,
				}),
			linterName,
		);

		if (summary.conclusion !== "success") {
			failed += 1;
		}

		rows.push(summary);

		const detailSection = buildDetailSection(summary);
		if (detailSection) {
			detailSections.push(detailSection);
		}
	}

	const total = selectedLinters.length;
	const overallConclusion =
		failed === 0 && decryptOutcome !== "failure" ? "success" : "failure";
	let overallSummary;

	if (decryptOutcome === "failure") {
		overallSummary =
			"One or more encrypted linter summaries could not be read. See the workflow logs.";
	} else if (overallConclusion === "success") {
		overallSummary = `All ${total} selected linter(s) completed successfully.`;
	} else {
		overallSummary = `${failed} of ${total} selected linter(s) reported issues or failed.`;
	}

	const commentLines = [
		COMMENT_MARKER,
		"## linter-service",
		"",
		overallSummary,
		"",
	];
	const checkRunLines = ["## linter-service", "", overallSummary, ""];

	appendSummaryTable(commentLines, rows);
	appendSummaryTable(checkRunLines, rows);
	appendTargetDetails(commentLines, rows);
	appendTargetDetails(checkRunLines, rows);
	appendFailureDetails(commentLines, detailSections);
	appendFailureDetails(checkRunLines, detailSections);

	return {
		checkRunText: `${checkRunLines.join("\n")}\n`,
		commentBody: `${commentLines.join("\n")}\n`,
		overallConclusion,
		overallSummary,
	};
}

function writeCombinedReportFiles({ checkRunText, commentBody, runnerTemp }) {
	fs.writeFileSync(
		path.join(runnerTemp, "combined-linter-comment.md"),
		commentBody,
		"utf8",
	);
	fs.writeFileSync(
		path.join(runnerTemp, "combined-linter-check-run.md"),
		checkRunText,
		"utf8",
	);
}

function appendSummaryTable(lines, rows) {
	if (rows.length === 0) {
		return;
	}

	lines.push("| Linter | Result | Summary |", "| --- | --- | --- |");

	for (const row of rows) {
		lines.push(
			[
				"|",
				` \`${row.linterName}\` `,
				"|",
				` ${escapeTableCell(buildResultLabel(row.status))} `,
				"|",
				` ${escapeTableCell(stripLeadingStatusMarker(row.summaryText))} `,
				"|",
			].join(""),
		);
	}
}

function appendTargetDetails(lines, rows) {
	const targetSections = rows
		.map((row) => buildTargetSection(row))
		.filter(Boolean);

	if (targetSections.length === 0) {
		return;
	}

	lines.push("");

	for (const [index, targetSection] of targetSections.entries()) {
		lines.push(targetSection);
		if (index !== targetSections.length - 1) {
			lines.push("");
		}
	}
}

function appendFailureDetails(lines, detailSections) {
	if (detailSections.length === 0) {
		return;
	}

	lines.push(
		"",
		`<details><summary>Show details for ${detailSections.length} failing linter(s)</summary>`,
		"",
	);

	for (const [index, detailSection] of detailSections.entries()) {
		lines.push(detailSection);
		if (index !== detailSections.length - 1) {
			lines.push("");
		}
	}

	lines.push("", "</details>");
}

function buildDetailSection(summary) {
	if (!isFailureLikeStatus(summary.status)) {
		return "";
	}

	const lines = [`### ${summary.linterName}`, ""];

	if (summary.status === "failure" && summary.detailsText.length > 0) {
		lines.push("```text", summary.detailsText, "```");
		return lines.join("\n");
	}

	lines.push(stripLeadingStatusMarker(summary.summaryText));
	return lines.join("\n");
}

function buildTargetSection(summary) {
	if (
		summary.selectedFiles.length === 0 &&
		summary.checkedProjects.length === 0
	) {
		return "";
	}

	const lines = [
		`<details><summary>Show checked targets for ${escapeHtml(summary.linterName)}</summary>`,
		"",
	];

	appendPathGroup(lines, "Target file paths", summary.selectedFiles);
	if (summary.checkedProjects.length > 0) {
		if (summary.selectedFiles.length > 0) {
			lines.push("");
		}
		appendPathGroup(lines, "Cargo project targets", summary.checkedProjects);
	}

	lines.push("", "</details>");
	return lines.join("\n");
}

function appendPathGroup(lines, title, paths) {
	if (paths.length === 0) {
		return;
	}

	const displayedPaths = paths.slice(0, MAX_TARGET_PATHS);
	lines.push(`${title}:`);

	for (const currentPath of displayedPaths) {
		lines.push(`- <code>${escapeHtml(currentPath)}</code>`);
	}

	if (paths.length > displayedPaths.length) {
		lines.push(
			`- ... ${paths.length - displayedPaths.length} more path(s) omitted`,
		);
	}
}

function buildFallbackSummary({ decryptOutcome, linterName }) {
	const summaryText =
		decryptOutcome === "failure"
			? `❌ The encrypted \`${linterName}\` summary could not be decrypted. See the workflow logs.`
			: `❌ The \`${linterName}\` workflow failed before producing a detailed report. See the workflow logs.`;

	return {
		checked_projects: [],
		conclusion: "failure",
		details_text: summaryText,
		linter_name: linterName,
		selected_files: [],
		status: "missing_summary",
		summary_text: summaryText,
		target_summary: "n/a",
	};
}

function buildResultLabel(status) {
	switch (status) {
		case "success":
			return "✅ Pass";
		case "no_targets":
			return "⚪ No targets";
		case "infra_failure":
			return "❌ Failed";
		case "missing_summary":
			return "❌ Missing summary";
		default:
			return "❌ Issues";
	}
}

function normalizeSummary(summary, linterName) {
	const normalizedConclusion =
		typeof summary?.conclusion === "string" && summary.conclusion.length > 0
			? summary.conclusion
			: "failure";
	const summaryText =
		typeof summary?.summary_text === "string" &&
		summary.summary_text.trim().length > 0
			? summary.summary_text.trim()
			: extractSummaryText(summary?.comment_body);

	return {
		checkedProjects: normalizeStringArray(summary?.checked_projects),
		conclusion: normalizedConclusion,
		detailsText:
			typeof summary?.details_text === "string"
				? summary.details_text.trim()
				: "",
		linterName,
		selectedFiles: normalizeStringArray(summary?.selected_files),
		status:
			typeof summary?.status === "string" && summary.status.length > 0
				? summary.status
				: normalizedConclusion === "success"
					? "success"
					: "failure",
		summaryText:
			summaryText.length > 0
				? summaryText
				: `❌ The \`${linterName}\` workflow failed before producing a detailed report. See the workflow logs.`,
		targetSummary:
			typeof summary?.target_summary === "string" &&
			summary.target_summary.trim().length > 0
				? summary.target_summary.trim()
				: "n/a",
	};
}

function extractSummaryText(commentBody) {
	if (typeof commentBody !== "string" || commentBody.trim().length === 0) {
		return "";
	}

	for (const rawLine of commentBody.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("### ")) {
			continue;
		}
		return line;
	}

	return "";
}

function isFailureLikeStatus(status) {
	return ["failure", "infra_failure", "missing_summary"].includes(status);
}

function readLinterSummaries(summaryRoot) {
	const summaries = new Map();

	if (!fs.existsSync(summaryRoot)) {
		return summaries;
	}

	const summaryFileNames = fs
		.readdirSync(summaryRoot)
		.filter(
			(fileName) =>
				fileName.startsWith("linter-summary-") && fileName.endsWith(".json"),
		)
		.sort();

	for (const fileName of summaryFileNames) {
		let summary;

		try {
			summary = JSON.parse(
				fs.readFileSync(path.join(summaryRoot, fileName), "utf8"),
			);
		} catch {
			continue;
		}

		if (
			summary &&
			typeof summary === "object" &&
			typeof summary.linter_name === "string"
		) {
			summaries.set(summary.linter_name, summary);
		}
	}

	return summaries;
}

function normalizeStringArray(value) {
	return Array.isArray(value)
		? value.filter(
				(entry) => typeof entry === "string" && entry.trim().length > 0,
			)
		: [];
}

function escapeTableCell(value) {
	return String(value || "")
		.replaceAll("|", "\\|")
		.replaceAll("\r", " ")
		.replaceAll("\n", " ");
}

function stripLeadingStatusMarker(text) {
	return String(text || "")
		.replace(/^[^A-Za-z0-9`]+/u, "")
		.trim();
}

function escapeHtml(value) {
	return String(value || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function parseSelectedLinters(rawValue) {
	let selectedLinters;

	try {
		selectedLinters = JSON.parse(rawValue);
	} catch {
		throw new Error("SELECTED_LINTERS_JSON must be valid JSON");
	}

	if (
		!Array.isArray(selectedLinters) ||
		selectedLinters.some((linterName) => typeof linterName !== "string")
	) {
		throw new Error("SELECTED_LINTERS_JSON must be a JSON array of strings");
	}

	return selectedLinters;
}

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	buildFallbackSummary,
	buildResultLabel,
	extractSummaryText,
	parseSelectedLinters,
	readLinterSummaries,
	renderCombinedReport,
	runFromEnv,
};
