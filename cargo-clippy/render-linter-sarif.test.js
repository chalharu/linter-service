const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");
const { renderReport } = require("../.github/scripts/render-linter-report.js");
const { runFromEnv } = require("../.github/scripts/render-linter-sarif.js");

const configPath = path.join(__dirname, "..", "linters.json");

test("emits SARIF for cargo-clippy structured diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-clippy-");

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn demo() {}\n");
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/lib.rs\n",
	);
	writeFile(
		path.join(context.runnerTemp, "cargo-clippy-structured-runs.json"),
		JSON.stringify([
			{
				command:
					"docker run cargo clippy --manifest-path Cargo.toml --all-targets -- -D warnings",
				diagnostics: [
					{
						manifest_path: "Cargo.toml",
						message: {
							code: {
								code: "clippy::needless_borrow",
								explanation: null,
							},
							children: [],
							level: "error",
							message: "needless borrow",
							rendered:
								"error: needless borrow\n --> src/lib.rs:12:3\n  |\n12 | let _value = &items;\n  |   ^^^\n",
							spans: [
								{
									column_start: 3,
									file_name: "src/lib.rs",
									is_primary: true,
									line_start: 12,
								},
							],
						},
						package_id: "path+file:///work#demo",
						target: {
							kind: ["lib"],
							name: "demo",
							src_path: "src/lib.rs",
						},
					},
				],
				exit_code: 1,
				manifest_path: "Cargo.toml",
			},
		]),
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: "",
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-clippy",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-clippy.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.ok(report.sarif.runs[0].results.length >= 1);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			12,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			3,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps cargo-clippy failing-file counts unavailable for config-only failures", () => {
	const context = makeTempRepo(
		"render-linter-sarif-cargo-clippy-config-failure-",
	);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn demo() {}\n");
	writeFile(path.join(context.repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		'[registries.private]\nindex = "sparse+https://example.invalid/index/"\n',
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"src/lib.rs\nsrc/main.rs\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details:
				"Repository-supplied `.cargo/config.toml` is not supported in this shared linter service because `cargo fetch` for untrusted pull requests cannot safely honor repository-controlled Cargo configuration.\nUse the default Cargo registry configuration for the shared `cargo-clippy` path.\n",
			exit_code: 1,
		}),
	);

	try {
		const sarifReport = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-clippy",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-clippy.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});
		const report = renderReport({
			configPath,
			exitCodeRaw: "1",
			installOutcome: "success",
			linterName: "cargo-clippy",
			resultPath: path.join(context.runnerTemp, "linter-result.json"),
			runOutcome: "success",
			selectedFilesPath: path.join(context.runnerTemp, "selected-files.txt"),
			selectOutcome: "success",
			sourceRepositoryPath: context.repoDir,
			targetStats: sarifReport.targetStats,
		});

		assert.equal(sarifReport.produced, true);
		assert.equal(sarifReport.targetStats.counts_known, false);
		assert.equal(sarifReport.targetStats.issue_target_count, null);
		assert.equal(sarifReport.targetStats.passed_target_count, null);
		assert.equal(sarifReport.targetStats.target_count, 2);
		assert.equal(sarifReport.sarif.runs[0].results.length, 1);
		assert.equal(sarifReport.sarif.runs[0].results[0].locations, undefined);
		assert.equal(
			report.summaryText,
			"❌ Checked 2 files; issue counts are unavailable.",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
