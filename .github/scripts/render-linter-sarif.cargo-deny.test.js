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
		assert.equal(report.sarif.runs[0].results[0].ruleId, "unlicensed");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"Cargo.toml",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("emits SARIF for cargo-deny audit-compatible advisories", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-deny-audit-");

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
			cargo_deny_runs: [
				{
					audit_reports: [
						{
							lockfile: { "dependency-count": 1 },
							settings: {},
							vulnerabilities: [
								{
									advisory: {
										id: "RUSTSEC-2024-0001",
										title: "Critical vulnerability",
									},
									package: {
										name: "demo",
										version: "0.1.0",
									},
								},
							],
							warnings: {},
						},
					],
					command:
						"cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output",
					config_path: null,
					diagnostics: [
						{
							fields: {
								advisory: {
									id: "RUSTSEC-2024-0001",
								},
								code: "vulnerability",
								labels: [
									{
										column: 1,
										line: 4,
										message: "security vulnerability detected",
										span: "demo 0.1.0",
									},
								],
								message: "Critical vulnerability",
								notes: ["ID: RUSTSEC-2024-0001"],
								severity: "error",
							},
							type: "diagnostic",
						},
					],
					exit_code: 1,
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
		assert.equal(report.sarif.runs[0].results[0].ruleId, "RUSTSEC-2024-0001");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"Cargo.toml",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			1,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("emits SARIF for cargo-deny structured config diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-deny-config-");

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
			cargo_deny_runs: [
				{
					audit_reports: [],
					command:
						"cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
					config_path: "deny.toml",
					diagnostics: [
						{
							fields: {
								code: "rejected",
								labels: [
									{
										column: 9,
										line: 5,
										message: "missing comma",
										span: 'allow = ["MIT" "Apache-2.0"]',
									},
								],
								message: "failed to parse config",
								notes: [],
								severity: "error",
							},
							type: "diagnostic",
						},
					],
					exit_code: 1,
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
		assert.equal(report.sarif.runs[0].results[0].ruleId, "cargo-deny/rejected");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps only the primary cargo-deny snippet location and preserves advisory IDs", () => {
	const context = makeTempRepo("render-linter-sarif-cargo-deny-advisory-");
	const copiedSourceRoot = path.join(
		context.runnerTemp,
		"cargo-deny-workspace/source",
	);
	const copiedLockPath = path.join(copiedSourceRoot, "Cargo.lock");
	const copiedDenyPath = path.join(copiedSourceRoot, "deny.toml");
	const advisoryDetails = [
		"error[RUSTSEC-2024-0001]: crate `demo 0.1.0` is vulnerable",
		"",
		`  ┌─ ${copiedLockPath}:50:1`,
		"  │",
		'50 │ name = "demo"',
		"  │ ^ vulnerable crate entry",
		"  │",
		`  ┌─ ${copiedDenyPath}:10:5`,
		"  │",
		"10 │ ignore = []",
		"   │     ^ advisory is not ignored here",
	].join("\n");

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		'[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	writeFile(
		path.join(context.repoDir, "Cargo.lock"),
		Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") +
			"\n",
	);
	writeFile(
		path.join(context.repoDir, "deny.toml"),
		Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") +
			"\n",
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"Cargo.lock\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details: advisoryDetails,
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
		assert.equal(report.sarif.runs[0].results[0].ruleId, "RUSTSEC-2024-0001");
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"Cargo.lock",
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startLine,
			50,
		);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation.region
				.startColumn,
			1,
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
