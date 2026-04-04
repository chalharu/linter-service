const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runFromEnv } = require("./render-combined-report.js");

test("writes comment and check-run reports from detailed linter summaries", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "render-combined-report-"),
	);
	const runnerTemp = path.join(tempDir, "runner-temp");
	const summaryRoot = path.join(tempDir, "summaries");
	const githubOutputPath = path.join(tempDir, "github-output.txt");

	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(summaryRoot, { recursive: true });
	fs.writeFileSync(
		path.join(summaryRoot, "linter-summary-actionlint.json"),
		JSON.stringify(
			{
				comment_body:
					"### actionlint\n\n✅ No issues were reported for the selected GitHub Actions workflow target(s).\n",
				checked_project_count: 0,
				conclusion: "success",
				details_text: "",
				linter_name: "actionlint",
				selected_file_count: 2,
				status: "success",
				summary_text:
					"✅ No issues were reported for the selected GitHub Actions workflow target(s).",
				target_summary: "2 file(s)",
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		path.join(summaryRoot, "linter-summary-rustfmt.json"),
		JSON.stringify(
			{
				comment_body:
					"### rustfmt\n\n❌ Rust formatting issues were detected.\n\n<details><summary>Details</summary>\n\n```text\ndiff --check failed\n```\n</details>\n",
				checked_project_count: 2,
				conclusion: "failure",
				details_text: "diff --check failed",
				linter_name: "rustfmt",
				selected_file_count: 4,
				status: "failure",
				summary_text: "❌ Rust formatting issues were detected.",
				target_summary: "4 file(s), 2 Cargo project(s)",
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		const report = runFromEnv({
			DECRYPT_SUMMARIES_OUTCOME: "success",
			GITHUB_OUTPUT: githubOutputPath,
			LINTER_SUMMARY_PATH: summaryRoot,
			RUNNER_TEMP: runnerTemp,
			SELECTED_LINTERS_JSON: JSON.stringify(["actionlint", "rustfmt"]),
		});
		const commentBody = fs.readFileSync(
			path.join(runnerTemp, "combined-linter-comment.md"),
			"utf8",
		);
		const checkRunText = fs.readFileSync(
			path.join(runnerTemp, "combined-linter-check-run.md"),
			"utf8",
		);
		const githubOutput = fs.readFileSync(githubOutputPath, "utf8");

		assert.equal(report.overallConclusion, "failure");
		assert.equal(
			report.overallSummary,
			"1 of 2 selected linter(s) reported issues or failed.",
		);
		assert.equal(
			commentBody,
			[
				"<!-- linter-service:results -->",
				"## linter-service",
				"",
				"1 of 2 selected linter(s) reported issues or failed.",
				"",
				"| Linter | Result | Scope | Summary |",
				"| --- | --- | --- | --- |",
				"| `actionlint` | ✅ Pass | 2 file(s) | No issues were reported for the selected GitHub Actions workflow target(s). |",
				"| `rustfmt` | ❌ Issues | 4 file(s), 2 Cargo project(s) | Rust formatting issues were detected. |",
				"",
				"<details><summary>Show details for 1 failing linter(s)</summary>",
				"",
				"### rustfmt",
				"",
				"```text",
				"diff --check failed",
				"```",
				"",
				"</details>",
				"",
			].join("\n"),
		);
		assert.equal(
			checkRunText,
			[
				"## linter-service",
				"",
				"1 of 2 selected linter(s) reported issues or failed.",
				"",
				"| Linter | Result | Scope | Summary |",
				"| --- | --- | --- | --- |",
				"| `actionlint` | ✅ Pass | 2 file(s) | No issues were reported for the selected GitHub Actions workflow target(s). |",
				"| `rustfmt` | ❌ Issues | 4 file(s), 2 Cargo project(s) | Rust formatting issues were detected. |",
				"",
				"<details><summary>Show details for 1 failing linter(s)</summary>",
				"",
				"### rustfmt",
				"",
				"```text",
				"diff --check failed",
				"```",
				"",
				"</details>",
				"",
			].join("\n"),
		);
		assert.match(githubOutput, /^overall_conclusion=failure$/m);
		assert.match(
			githubOutput,
			/^overall_summary=1 of 2 selected linter\(s\) reported issues or failed\.$/m,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("falls back to decrypt failure messaging when detailed summaries are unavailable", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "render-combined-report-missing-"),
	);
	const runnerTemp = path.join(tempDir, "runner-temp");
	const summaryRoot = path.join(tempDir, "summaries");

	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(summaryRoot, { recursive: true });

	try {
		const report = runFromEnv({
			DECRYPT_SUMMARIES_OUTCOME: "failure",
			LINTER_SUMMARY_PATH: summaryRoot,
			RUNNER_TEMP: runnerTemp,
			SELECTED_LINTERS_JSON: JSON.stringify(["cargo-deny"]),
		});
		const commentBody = fs.readFileSync(
			path.join(runnerTemp, "combined-linter-comment.md"),
			"utf8",
		);
		const checkRunText = fs.readFileSync(
			path.join(runnerTemp, "combined-linter-check-run.md"),
			"utf8",
		);

		assert.equal(report.overallConclusion, "failure");
		assert.equal(
			report.overallSummary,
			"One or more encrypted linter summaries could not be read. See the workflow logs.",
		);
		assert.match(
			commentBody,
			/\| `cargo-deny` \| ❌ Missing summary \| n\/a \| The encrypted `cargo-deny` summary could not be decrypted\. See the workflow logs\. \|/,
		);
		assert.doesNotMatch(checkRunText, /<!-- linter-service:results -->/);
		assert.match(
			checkRunText,
			/### cargo-deny\n\nThe encrypted `cargo-deny` summary could not be decrypted\. See the workflow logs\./,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
