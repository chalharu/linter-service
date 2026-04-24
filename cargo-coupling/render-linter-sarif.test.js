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

test("emits SARIF for cargo-coupling issues and cycles", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-coupling-");

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
			cargo_coupling_runs: [
				{
					analysis_path: "src",
					check_result: {
						circular_count: 1,
						critical_count: 1,
						failures: ["Grade C is below minimum B"],
						grade: "C",
						high_count: 0,
						medium_count: 0,
						passed: false,
						score: 0.5,
					},
					command: "docker run cargo-coupling coupling --json --no-git src",
					exit_code: 0,
					json_output: {
						circular_dependencies: [["demo::a", "demo::b", "demo::a"]],
						hotspots: [],
						issues: [
							{
								description:
									"Intrusive coupling across a distant module boundary",
								issue_type: "Global Complexity",
								severity: "Critical",
								source: "demo::a",
								suggestion: "Introduce a trait boundary.",
								target: "demo::b",
							},
						],
						modules: [
							{
								file_path: "src/lib.rs",
								name: "demo::a",
							},
							{
								file_path: "src/lib.rs",
								name: "demo::b",
							},
						],
						summary: {
							critical_issues: 1,
							health_grade: "C",
							health_score: 0.5,
							high_issues: 0,
							medium_issues: 0,
							total_couplings: 1,
							total_modules: 2,
						},
					},
					manifest_path: "Cargo.toml",
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
			LINTER_NAME: "cargo-coupling",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-coupling.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.deepEqual(
			report.sarif.runs[0].results.map((result) => result.ruleId),
			[
				"cargo-coupling/global-complexity",
				"cargo-coupling/circular-dependency",
			],
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"src/lib.rs",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
