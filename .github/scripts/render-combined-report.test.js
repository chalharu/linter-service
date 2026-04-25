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
				comment_body: "### actionlint\n\n✅ 2 / 2 files passed.\n",
				checked_project_count: 0,
				checked_projects: [],
				conclusion: "success",
				counts_known: true,
				details_text: "",
				issue_count: 0,
				issue_target_count: 0,
				linter_name: "actionlint",
				passed_target_count: 2,
				selected_files: [
					".github/workflows/ci.yml",
					".github/workflows/release.yml",
				],
				selected_file_count: 2,
				status: "success",
				summary_text: "✅ 2 / 2 files passed.",
				target_count: 2,
				target_kind: "file",
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
					"### rustfmt\n\n❌ 0 / 2 files passed; 2 files reported issues.\n\n<details><summary>Details</summary>\n\n```text\ndiff --check failed\n```\n</details>\n",
				checked_project_count: 2,
				checked_projects: ["Cargo.toml", "crates/member/Cargo.toml"],
				conclusion: "failure",
				counts_known: true,
				details_text: "diff --check failed",
				issue_count: 2,
				issue_target_count: 2,
				linter_name: "rustfmt",
				passed_target_count: 0,
				selected_files: ["src/lib.rs", "crates/member/src/lib.rs"],
				selected_file_count: 2,
				status: "failure",
				summary_text: "❌ 0 / 2 files passed; 2 files reported issues.",
				target_count: 2,
				target_kind: "file",
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
				"| Linter | Result | Checked | Passed | Issues |",
				"| --- | --- | --- | ---: | ---: |",
				"| `actionlint` | ✅ Pass | 2 files | 2 | 0 |",
				"| `rustfmt` | ❌ Issues | 2 files | 0 | 2 |",
				"",
				"<details><summary>Show checked targets for actionlint</summary>",
				"",
				"Target file paths:",
				"- <code>.github/workflows/ci.yml</code>",
				"- <code>.github/workflows/release.yml</code>",
				"",
				"</details>",
				"",
				"<details><summary>Show checked targets for rustfmt</summary>",
				"",
				"Target file paths:",
				"- <code>src/lib.rs</code>",
				"- <code>crates/member/src/lib.rs</code>",
				"",
				"Cargo project targets:",
				"- <code>Cargo.toml</code>",
				"- <code>crates/member/Cargo.toml</code>",
				"",
				"</details>",
				"",
				"<details><summary>Show details for 1 linter(s) with warnings or failures</summary>",
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
				"| Linter | Result | Checked | Passed | Issues |",
				"| --- | --- | --- | ---: | ---: |",
				"| `actionlint` | ✅ Pass | 2 files | 2 | 0 |",
				"| `rustfmt` | ❌ Issues | 2 files | 0 | 2 |",
				"",
				"<details><summary>Show checked targets for actionlint</summary>",
				"",
				"Target file paths:",
				"- <code>.github/workflows/ci.yml</code>",
				"- <code>.github/workflows/release.yml</code>",
				"",
				"</details>",
				"",
				"<details><summary>Show checked targets for rustfmt</summary>",
				"",
				"Target file paths:",
				"- <code>src/lib.rs</code>",
				"- <code>crates/member/src/lib.rs</code>",
				"",
				"Cargo project targets:",
				"- <code>Cargo.toml</code>",
				"- <code>crates/member/Cargo.toml</code>",
				"",
				"</details>",
				"",
				"<details><summary>Show details for 1 linter(s) with warnings or failures</summary>",
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
		assert.match(githubOutput, /^overall_status=failure$/m);
		assert.match(
			githubOutput,
			/^overall_summary=1 of 2 selected linter\(s\) reported issues or failed\.$/m,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("treats warning summaries as non-blocking findings in combined output", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "render-combined-report-warning-"),
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
				comment_body: "### actionlint\n\n✅ 1 / 1 file passed.\n",
				checked_project_count: 0,
				checked_projects: [],
				conclusion: "success",
				counts_known: true,
				details_text: "",
				issue_count: 0,
				issue_target_count: 0,
				linter_name: "actionlint",
				passed_target_count: 1,
				selected_files: [".github/workflows/ci.yml"],
				selected_file_count: 1,
				status: "success",
				summary_text: "✅ 1 / 1 file passed.",
				target_count: 1,
				target_kind: "file",
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		path.join(summaryRoot, "linter-summary-cargo-deny.json"),
		JSON.stringify(
			{
				comment_body:
					"### cargo-deny\n\n⚠️ Checked 1 Cargo project; 1 Cargo project reported warnings.\n\n<details><summary>Details</summary>\n\n```text\nwarning[duplicate]: found 2 duplicate entries for crate 'block-buffer'\n```\n</details>\n",
				checked_project_count: 1,
				checked_projects: ["Cargo.toml"],
				conclusion: "success",
				counts_known: true,
				details_text:
					"warning[duplicate]: found 2 duplicate entries for crate 'block-buffer'",
				issue_count: 1,
				issue_target_count: 1,
				linter_name: "cargo-deny",
				passed_target_count: 0,
				selected_files: ["Cargo.lock"],
				selected_file_count: 1,
				status: "warning",
				summary_text:
					"⚠️ Checked 1 Cargo project; 1 Cargo project reported warnings.",
				target_count: 1,
				target_kind: "cargo-project",
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
			SELECTED_LINTERS_JSON: JSON.stringify(["actionlint", "cargo-deny"]),
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

		assert.equal(report.overallConclusion, "success");
		assert.equal(report.overallStatus, "warning");
		assert.equal(
			report.overallSummary,
			"All 2 selected linter(s) completed successfully; 1 reported warnings.",
		);
		assert.match(
			commentBody,
			/\| `cargo-deny` \| ⚠️ Warning \| 1 Cargo project \| 0 \| 1 \|/,
		);
		assert.match(
			commentBody,
			/<details><summary>Show details for 1 linter\(s\) with warnings or failures<\/summary>/,
		);
		assert.match(
			commentBody,
			/### cargo-deny\n\n```text\nwarning\[duplicate\]: found 2 duplicate entries for crate 'block-buffer'\n```/,
		);
		assert.match(
			checkRunText,
			/\| `cargo-deny` \| ⚠️ Warning \| 1 Cargo project \| 0 \| 1 \|/,
		);
		assert.match(githubOutput, /^overall_conclusion=success$/m);
		assert.match(githubOutput, /^overall_status=warning$/m);
		assert.match(
			githubOutput,
			/^overall_summary=All 2 selected linter\(s\) completed successfully; 1 reported warnings\.$/m,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("renders Biome detail blocks from per-linter summary details", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "render-combined-report-biome-"),
	);
	const runnerTemp = path.join(tempDir, "runner-temp");
	const summaryRoot = path.join(tempDir, "summaries");

	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(summaryRoot, { recursive: true });
	fs.writeFileSync(
		path.join(summaryRoot, "linter-summary-biome.json"),
		JSON.stringify(
			{
				comment_body:
					"### biome\n\n❌ Checked 1 file; issue counts are unavailable.\n\n<details><summary>Details</summary>\n\n```text\nlint summary only\n```\n</details>\n",
				checked_project_count: 0,
				checked_projects: [],
				conclusion: "failure",
				counts_known: false,
				details_text:
					"src/app.ts:4:3 lint/suspicious/noDebugger debug statements are not allowed",
				issue_count: null,
				issue_target_count: null,
				linter_name: "biome",
				passed_target_count: null,
				selected_files: ["src/app.ts"],
				selected_file_count: 1,
				status: "failure",
				summary_text: "❌ Checked 1 file; issue counts are unavailable.",
				target_count: 1,
				target_kind: "file",
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		const report = runFromEnv({
			DECRYPT_SUMMARIES_OUTCOME: "success",
			LINTER_SUMMARY_PATH: summaryRoot,
			RUNNER_TEMP: runnerTemp,
			SELECTED_LINTERS_JSON: JSON.stringify(["biome"]),
		});
		const commentBody = fs.readFileSync(
			path.join(runnerTemp, "combined-linter-comment.md"),
			"utf8",
		);

		assert.equal(report.overallConclusion, "failure");
		assert.match(
			commentBody,
			/### biome\n\n```text\nsrc\/app\.ts:4:3 lint\/suspicious\/noDebugger debug statements are not allowed\n```/,
		);
		assert.doesNotMatch(commentBody, /lint summary only/);
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
			/\| `cargo-deny` \| ❌ Missing summary \| 0 files \| n\/a \| n\/a \|/,
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
