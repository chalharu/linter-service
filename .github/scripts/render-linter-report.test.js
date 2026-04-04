const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./cargo-linter-test-lib.js");
const { runFromEnv } = require("./render-linter-report.js");

const configPath = path.join(__dirname, "..", "..", "linters.json");

test("lists checked file paths in a successful non-cargo linter report", () => {
	const context = makeTempRepo("render-linter-report-non-cargo-");

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${[".github/workflows/ci.yml", ".github/workflows/release.yml"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "actionlint",
			}),
		);
		const summary = readSummary(context.runnerTemp, "actionlint");

		assert.equal(report.conclusion, "success");
		assert.deepEqual(report.selectedFiles, [
			".github/workflows/ci.yml",
			".github/workflows/release.yml",
		]);
		assert.match(report.body, /### actionlint/);
		assert.match(
			report.body,
			/✅ No issues were reported for the selected GitHub Actions workflow target\(s\)\./,
		);
		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /- <code>\.github\/workflows\/ci\.yml<\/code>/);
		assert.doesNotMatch(report.body, /2 changed GitHub Actions workflow/);
		assert.equal(summary.comment_body, report.body);
		assert.equal(summary.conclusion, "success");
		assert.equal(summary.status, "success");
		assert.equal(
			summary.summary_text,
			"✅ No issues were reported for the selected GitHub Actions workflow target(s).",
		);
		assert.equal(summary.target_summary, "2 file(s)");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("collapses long target path lists in reports", () => {
	const context = makeTempRepo("render-linter-report-collapsed-paths-");
	const selectedFiles = Array.from(
		{ length: 12 },
		(_, index) => `docs/file-${index + 1}.md`,
	);

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${selectedFiles.join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "markdownlint-cli2",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.match(
			report.body,
			/Target file paths:\n\n<details><summary>Show 12 path\(s\)<\/summary>/,
		);
		assert.match(report.body, /- <code>docs\/file-1\.md<\/code>/);
		assert.match(report.body, /- <code>docs\/file-12\.md<\/code>/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("treats rustfmt as selected Rust files instead of Cargo projects", () => {
	const context = makeTempRepo("render-linter-report-rustfmt-files-");

	populateCargoRepo(context.repoDir);

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["src/lib.rs", "crates/member/src/lib.rs"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "rustfmt",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.deepEqual(report.checkedProjects, []);
		assert.match(
			report.body,
			/✅ No issues were reported for the selected Rust file target\(s\)\./,
		);
		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /- <code>src\/lib\.rs<\/code>/);
		assert.match(report.body, /- <code>crates\/member\/src\/lib\.rs<\/code>/);
		assert.doesNotMatch(report.body, /Cargo project targets:/);
		assert.doesNotMatch(report.body, /Cargo\.toml/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("lists checked Cargo projects alongside changed file paths", () => {
	const context = makeTempRepo("render-linter-report-cargo-");

	populateCargoRepo(context.repoDir);

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["src/lib.rs", "src/main.rs", "crates/member/src/lib.rs"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "cargo-clippy",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.deepEqual(report.checkedProjects, [
			"Cargo.toml",
			"crates/member/Cargo.toml",
		]);
		assert.match(
			report.body,
			/✅ No issues were reported for the selected Cargo project target\(s\)\./,
		);
		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /Cargo project targets:/);
		assert.match(report.body, /- <code>src\/lib\.rs<\/code>/);
		assert.match(report.body, /- <code>Cargo\.toml<\/code>/);
		assert.match(report.body, /- <code>crates\/member\/Cargo\.toml<\/code>/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("lists checked Cargo projects for cargo-deny dependency target files", () => {
	const context = makeTempRepo("render-linter-report-cargo-deny-");

	populateCargoRepo(context.repoDir);
	writeFile(path.join(context.repoDir, "Cargo.lock"), "version = 3\n");
	writeFile(
		path.join(context.repoDir, "crates/member/deny.toml"),
		"[graph]\nall-features = true\n",
	);

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["Cargo.lock", "crates/member/deny.toml"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "cargo-deny",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.deepEqual(report.checkedProjects, [
			"Cargo.toml",
			"crates/member/Cargo.toml",
		]);
		assert.match(
			report.body,
			/✅ No issues were reported for the selected Cargo project target\(s\)\./,
		);
		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /Cargo project targets:/);
		assert.match(report.body, /- <code>Cargo\.lock<\/code>/);
		assert.match(report.body, /- <code>crates\/member\/deny\.toml<\/code>/);
		assert.match(report.body, /- <code>Cargo\.toml<\/code>/);
		assert.match(report.body, /- <code>crates\/member\/Cargo\.toml<\/code>/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("lists checked Cargo projects for repo-root cargo-deny policy files in nested-only repos", () => {
	const context = makeTempRepo("render-linter-report-cargo-deny-root-policy-");

	writeFile(
		path.join(context.repoDir, "deny.toml"),
		"[graph]\nall-features = true\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["deny.toml"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "cargo-deny",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.deepEqual(report.checkedProjects, ["crates/member/Cargo.toml"]);
		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /Cargo project targets:/);
		assert.match(report.body, /- <code>deny\.toml<\/code>/);
		assert.match(report.body, /- <code>crates\/member\/Cargo\.toml<\/code>/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("includes checked targets before diagnostic details on failure", () => {
	const context = makeTempRepo("render-linter-report-failure-");

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["openapi/spec.yaml"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "line 2: unexpected field", exit_code: 1 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "1",
				LINTER_NAME: "spectral",
			}),
		);

		assert.equal(report.conclusion, "failure");
		assert.match(
			report.body,
			/❌ Issues were reported for the selected YAML or JSON target\(s\)\./,
		);
		assert.match(
			report.body,
			/Target file paths:\n- <code>openapi\/spec\.yaml<\/code>\n\n<details><summary>Details<\/summary>/,
		);
		assert.match(report.body, /line 2: unexpected field/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("renders target paths safely when they contain Markdown-breaking backticks", () => {
	const context = makeTempRepo("render-linter-report-escaped-path-");

	try {
		fs.writeFileSync(
			path.join(context.runnerTemp, "selected-files.txt"),
			`${["docs/with`tick`.md"].join("\n")}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(context.runnerTemp, "linter-result.json"),
			JSON.stringify({ details: "", exit_code: 0 }),
			"utf8",
		);

		const report = runFromEnv(
			createReportEnv(context, {
				EXIT_CODE: "0",
				LINTER_NAME: "markdownlint-cli2",
			}),
		);

		assert.match(report.body, /Target file paths:/);
		assert.match(report.body, /<code>docs\/with`tick`\.md<\/code>/);
		assert.doesNotMatch(report.body, /- `docs\/with`tick`\.md`/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps no-files reports free from checked target sections", () => {
	const context = makeTempRepo("render-linter-report-no-files-");

	try {
		const report = runFromEnv(
			createReportEnv(context, {
				LINTER_NAME: "ruff",
			}),
		);

		assert.equal(report.conclusion, "success");
		assert.equal(report.selectedFiles.length, 0);
		assert.equal(report.checkedProjects.length, 0);
		assert.equal(report.status, "no_targets");
		assert.equal(report.targetSummary, "n/a");
		assert.match(
			report.body,
			/No matching Python files were selected for `ruff`\./,
		);
		assert.doesNotMatch(report.body, /Target file paths:/);
		assert.doesNotMatch(report.body, /Cargo project targets:/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

function createReportEnv(context, overrides = {}) {
	return {
		EXIT_CODE: "",
		INSTALL_TOOL_OUTCOME: "success",
		LINTER_CONFIG_PATH: configPath,
		LINTER_NAME: "actionlint",
		RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
		RUNNER_TEMP: context.runnerTemp,
		RUN_LINTER_OUTCOME: "success",
		SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
		SELECT_FILES_OUTCOME: "success",
		SOURCE_REPOSITORY_PATH: context.repoDir,
		...overrides,
	};
}

function populateCargoRepo(repoDir) {
	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(path.join(repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);
}

function readSummary(runnerTemp, linterName) {
	return JSON.parse(
		fs.readFileSync(
			path.join(runnerTemp, `linter-summary-${linterName}.json`),
			"utf8",
		),
	);
}
