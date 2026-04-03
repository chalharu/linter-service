const fs = require("node:fs");
const path = require("node:path");

const COMMENT_MARKER = "<!-- linter-service:results -->";

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
	const sections = [];
	let failed = 0;

	for (const linterName of selectedLinters) {
		const summary = summaries.get(linterName) ?? {};
		const conclusion = String(summary.conclusion || "");
		let section = String(summary.comment_body || "").trim();

		if (!section) {
			section = buildFallbackSection({
				decryptOutcome,
				linterName,
			});
		}

		if (conclusion !== "success") {
			failed += 1;
		}

		if (section) {
			sections.push(section);
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

	appendSections(commentLines, sections);
	appendSections(checkRunLines, sections);

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

function appendSections(lines, sections) {
	for (const [index, section] of sections.entries()) {
		lines.push(section);
		if (index !== sections.length - 1) {
			lines.push("");
		}
	}
}

function buildFallbackSection({ decryptOutcome, linterName }) {
	if (decryptOutcome === "failure") {
		return [
			`### ${linterName}`,
			"",
			`❌ The encrypted \`${linterName}\` summary could not be decrypted. See the workflow logs.`,
		].join("\n");
	}

	return [
		`### ${linterName}`,
		"",
		`❌ The \`${linterName}\` workflow failed before producing a detailed report. See the workflow logs.`,
	].join("\n");
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
	buildFallbackSection,
	parseSelectedLinters,
	readLinterSummaries,
	renderCombinedReport,
	runFromEnv,
};
