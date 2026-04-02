const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./linters/cargo-linter-test-lib.js");
const { runFromEnv } = require("./render-linter-sarif.js");

const configPath = path.join(__dirname, "linters/config.json");
const details = "error[unlicensed]: crate is unlicensed";

test("emits SARIF for cargo-deny diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-deny-");

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(path.join(context.repoDir, "Cargo.lock"), "version = 3\n");
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"Cargo.lock\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details,
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-deny",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-deny.sarif"),
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
			"Cargo.toml",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("maps cargo-deny snippet diagnostics from the temp workspace back to deny.toml", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-deny-snippet-");
	const copiedSourceRoot = path.join(
		context.runnerTemp,
		"cargo-deny-workspace/source",
	);
	const copiedDenyPath = path.join(copiedSourceRoot, "deny.toml");
	const snippetDetails = [
		`error[rejected]: failed to parse config from ${copiedDenyPath}`,
		"",
		`  ┌─ ${copiedDenyPath}:5:9`,
		"  │",
		'5 │ allow = ["MIT" "Apache-2.0"]',
		"  │         ^ missing comma",
	].join("\n");

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(
		path.join(context.repoDir, "deny.toml"),
		[
			"[licenses]",
			"version = 2",
			"unused = true",
			"exceptions = []",
			'allow = ["MIT", "Apache-2.0"]',
			"",
		].join("\n"),
	);
	writeFile(path.join(context.runnerTemp, "selected-files.txt"), "deny.toml\n");
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: snippetDetails,
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "cargo-deny",
			OUTPUT_PATH: path.join(context.runnerTemp, "cargo-deny.sarif"),
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
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"deny.toml",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			5,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			9,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
