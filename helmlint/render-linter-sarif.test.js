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

test("emits SARIF for helmlint path diagnostics", () => {
	const context = makeTempRepo("render-linter-sarif-helmlint-");

	writeFile(
		path.join(context.repoDir, "charts/demo/Chart.yaml"),
		"apiVersion: v2\nname: demo\nversion: 0.1.0\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/demo/templates/configmap.yaml"),
		"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"charts/demo/Chart.yaml\ncharts/demo/templates/configmap.yaml\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details:
				"==> helm lint charts/demo\n==> Linting charts/demo\n[INFO] Chart.yaml: icon is recommended\n[ERROR] templates/configmap.yaml: unable to parse YAML: error converting YAML to JSON: yaml: line 4: could not find expected ':'",
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "helmlint",
			OUTPUT_PATH: path.join(context.runnerTemp, "helmlint.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results.length, 2);
		assert.equal(
			report.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			"charts/demo/Chart.yaml",
		);
		assert.equal(
			report.sarif.runs[0].results[1].locations[0].physicalLocation
				.artifactLocation.uri,
			"charts/demo/templates/configmap.yaml",
		);
		assert.equal(
			report.sarif.runs[0].results[1].locations[0].physicalLocation.region
				.startLine,
			4,
		);
		assert.equal(
			report.sarif.runs[0].results[1].locations[0].physicalLocation.region
				.startColumn,
			1,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("keeps INFO helmlint diagnostics as note even when the message mentions error", () => {
	const context = makeTempRepo("render-linter-sarif-helmlint-info-");

	writeFile(
		path.join(context.repoDir, "charts/demo/Chart.yaml"),
		"apiVersion: v2\nname: demo\nversion: 0.1.0\n",
	);
	writeFile(
		path.join(context.runnerTemp, "selected-files.txt"),
		"charts/demo/Chart.yaml\n",
	);
	writeFile(
		path.join(context.runnerTemp, "linter-result.json"),
		JSON.stringify({
			details:
				"==> helm lint charts/demo\n==> Linting charts/demo\n[INFO] Chart.yaml: error field 'icon' is missing",
			exit_code: 1,
		}),
	);

	try {
		const report = runFromEnv({
			INSTALL_TOOL_OUTCOME: "success",
			LINTER_CONFIG_PATH: configPath,
			LINTER_NAME: "helmlint",
			OUTPUT_PATH: path.join(context.runnerTemp, "helmlint.sarif"),
			RESULT_PATH: path.join(context.runnerTemp, "linter-result.json"),
			RUNNER_TEMP: context.runnerTemp,
			RUN_LINTER_OUTCOME: "success",
			SELECTED_FILES_PATH: path.join(context.runnerTemp, "selected-files.txt"),
			SELECT_FILES_OUTCOME: "success",
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.equal(report.produced, true);
		assert.equal(report.sarif.runs[0].results[0].level, "note");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
