const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");
const { runFromEnv } = require("../.github/scripts/render-linter-sarif.js");

const configPath = path.join(__dirname, "..", "linters.json");

const LONG_SYMBOL = "a".repeat(1025);

test("emits SARIF for cargo-symbol-length findings", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-symbol-length-");

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
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			cargo_symbol_length_runs: [
				{
					command:
						"cargo rustc --manifest-path Cargo.toml --lib -- --emit=obj -o /cargo-target/symbol-scan-1.o",
					exit_code: 0,
					findings: [
						{
							length: 1025,
							symbol: LONG_SYMBOL,
							target_src_path: "src/lib.rs",
						},
					],
					manifest_path: "Cargo.toml",
					target_kind: "lib",
					target_name: "demo",
					target_src_path: "src/lib.rs",
				},
			],
			details: "",
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-symbol-length",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-symbol-length.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 1);
		assert.equal(
			report.sarif.runs[0].results[0].ruleId,
			"cargo-symbol-length/symbol-too-long",
		);
		assert.equal(report.sarif.runs[0].results[0].level, "error");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
		assert.match(
			report.sarif.runs[0].results[0].message.text,
			/Symbol name is 1025 characters long \(exceeds threshold\)/u,
		);
		assert.equal(report.sarif.runs[0].tool.driver.rules.length, 1);
		assert.equal(
			report.sarif.runs[0].tool.driver.rules[0].id,
			"cargo-symbol-length/symbol-too-long",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("emits empty SARIF when no cargo-symbol-length findings", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-symbol-length-pass-");

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
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			cargo_symbol_length_runs: [
				{
					command:
						"cargo rustc --manifest-path Cargo.toml --lib -- --emit=obj -o /cargo-target/symbol-scan-1.o",
					exit_code: 0,
					findings: [],
					manifest_path: "Cargo.toml",
					target_kind: "lib",
					target_name: "demo",
					target_src_path: "src/lib.rs",
				},
			],
			details: "",
			exit_code: 0,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-symbol-length",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-symbol-length.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 0);
		assert.equal(report.sarif.runs[0].tool.driver.rules.length, 0);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("truncates long symbol names in SARIF message to 120 characters plus ellipsis", () => {
	const context = makeTempRepo(
		"render-linter-sarif-cargo-symbol-length-trunc-",
	);
	const veryLongSymbol = "z".repeat(200);

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
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			cargo_symbol_length_runs: [
				{
					command:
						"cargo rustc --manifest-path Cargo.toml --lib -- --emit=obj -o /cargo-target/symbol-scan-1.o",
					exit_code: 0,
					findings: [
						{
							length: 200,
							symbol: veryLongSymbol,
							target_src_path: "src/lib.rs",
						},
					],
					manifest_path: "Cargo.toml",
					target_kind: "lib",
					target_name: "demo",
					target_src_path: "src/lib.rs",
				},
			],
			details: "",
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-symbol-length",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-symbol-length.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		const messageText = report.sarif.runs[0].results[0].message.text;
		// Symbol in message should be truncated to 120 chars + ellipsis
		assert.match(messageText, /z{120}…/u);
		// Full 200-char symbol should not appear
		assert.ok(!messageText.includes("z".repeat(200)));
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
