const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { renderReport } = require("./render-linter-report.js");
const { renderSarif } = require("./render-linter-sarif.js");
const { runFromEnv: selectLintTargets } = require("./select-lint-targets.js");
const { applyWorkflowEnvironment } = require("./workflow-command-env.js");

function runFromEnv(env = process.env) {
	const result = runLinterBatch({
		baseEnv: env,
		contextPath: requireEnv(env, "CONTEXT_PATH"),
		linterConfigPath: requireEnv(env, "LINTER_CONFIG_PATH"),
		linterNames: parseLinterNames(requireEnv(env, "LINTER_NAMES_JSON")),
		linterServicePath: requireEnv(env, "LINTER_SERVICE_PATH"),
		runnerTemp: requireEnv(env, "RUNNER_TEMP"),
		sourceRepositoryPath: requireEnv(env, "SOURCE_REPOSITORY_PATH"),
	});

	if (result.infrastructureFailures > 0) {
		process.exitCode = 1;
	}

	return result;
}

function runLinterBatch({
	applyWorkflowEnvironmentImpl = applyWorkflowEnvironment,
	baseEnv,
	contextPath,
	execFileSyncImpl = execFileSync,
	linterConfigPath,
	linterNames,
	linterServicePath,
	renderReportImpl = renderReport,
	renderSarifImpl = renderSarif,
	runnerTemp,
	selectLintTargetsImpl = selectLintTargets,
	sourceRepositoryPath,
}) {
	const executionBaseEnv = {
		...baseEnv,
		LINTER_CONFIG_PATH: linterConfigPath,
		LINTER_SERVICE_PATH: linterServicePath,
		RUNNER_TEMP: runnerTemp,
		SOURCE_REPOSITORY_PATH: sourceRepositoryPath,
	};
	let executionEnv = executionBaseEnv;
	let infrastructureFailures = 0;
	const linters = [];

	for (const linterName of linterNames) {
		console.log(`::group::${linterName}`);
		const workDir = path.join(runnerTemp, "linter-batch", linterName);
		const patternPath = path.join(workDir, "patterns.txt");
		const selectedFilesPath = path.join(workDir, "selected-files.txt");
		const resultPath = path.join(workDir, "linter-result.json");
		const summaryPath = path.join(
			runnerTemp,
			`linter-summary-${linterName}.json`,
		);
		const sarifPath = path.join(runnerTemp, `linter-sarif-${linterName}.sarif`);
		let selectOutcome = "success";
		let installOutcome = "skipped";
		let runOutcome = "skipped";
		let exitCodeRaw = "";

		fs.rmSync(workDir, { force: true, recursive: true });
		fs.mkdirSync(workDir, { recursive: true });
		fs.rmSync(summaryPath, { force: true });
		fs.rmSync(sarifPath, { force: true });

		try {
			const patterns = execFileSyncImpl(
				"bash",
				[path.join(linterServicePath, linterName, "patterns.sh")],
				{
					cwd: linterServicePath,
					encoding: "utf8",
					env: executionEnv,
				},
			);
			fs.writeFileSync(patternPath, patterns, "utf8");
			selectLintTargetsImpl({
				...executionEnv,
				CONTEXT_PATH: contextPath,
				LINTER_NAME: linterName,
				OUTPUT_PATH: selectedFilesPath,
				PATTERN_PATH: patternPath,
				SOURCE_REPOSITORY_PATH: sourceRepositoryPath,
			});
		} catch (error) {
			selectOutcome = "failure";
			infrastructureFailures += 1;
			logStepFailure("select", linterName, error);
		}

		const selectedFiles = readLines(selectedFilesPath);
		if (selectOutcome === "success" && selectedFiles.length > 0) {
			try {
				executionEnv = installLinterTools({
					applyWorkflowEnvironmentImpl,
					execFileSyncImpl,
					executionEnv,
					linterName,
					linterServicePath,
					runnerTemp,
				});
				installOutcome = "success";
			} catch (error) {
				installOutcome = "failure";
				infrastructureFailures += 1;
				logStepFailure("install", linterName, error);
			}
		}

		if (installOutcome === "success" && selectedFiles.length > 0) {
			try {
				const output = execFileSyncImpl(
					"bash",
					[
						path.join(linterServicePath, linterName, "run.sh"),
						...selectedFiles,
					],
					{
						cwd: sourceRepositoryPath,
						encoding: "utf8",
						env: executionEnv,
					},
				);
				fs.writeFileSync(resultPath, output, "utf8");
				const parsed = JSON.parse(output);

				if (!Number.isInteger(parsed.exit_code)) {
					throw new Error(
						`${linterName} run.sh output must include integer exit_code`,
					);
				}

				exitCodeRaw = String(parsed.exit_code);
				runOutcome = "success";
			} catch (error) {
				runOutcome = "failure";
				infrastructureFailures += 1;
				logStepFailure("run", linterName, error);
			}
		}

		try {
			const report = renderReportImpl({
				configPath: linterConfigPath,
				exitCodeRaw,
				installOutcome,
				linterName,
				resultPath,
				runOutcome,
				selectedFilesPath,
				selectOutcome,
				sourceRepositoryPath,
			});

			fs.writeFileSync(
				summaryPath,
				JSON.stringify(
					{
						comment_body: report.body,
						conclusion: report.conclusion,
						linter_name: linterName,
					},
					null,
					2,
				),
				"utf8",
			);

			const sarifReport = renderSarifImpl({
				configPath: linterConfigPath,
				installOutcome,
				linterName,
				outputPath: sarifPath,
				resultPath,
				runnerTemp,
				runOutcome,
				selectedFilesPath,
				selectOutcome,
				sourceRepositoryPath,
			});

			if (sarifReport.produced) {
				fs.writeFileSync(
					sarifReport.outputPath,
					JSON.stringify(sarifReport.sarif, null, 2),
					"utf8",
				);
			}

			linters.push({
				conclusion: report.conclusion,
				exitCodeRaw,
				installOutcome,
				linterName,
				resultPath,
				runOutcome,
				sarifProduced: sarifReport.produced,
				selectOutcome,
				selectedFiles,
			});
		} catch (error) {
			infrastructureFailures += 1;
			logStepFailure("render", linterName, error);
			linters.push({
				conclusion: "failure",
				exitCodeRaw,
				installOutcome,
				linterName,
				resultPath,
				runOutcome,
				sarifProduced: false,
				selectOutcome,
				selectedFiles,
			});
		}

		console.log(
			`${linterName}: selected ${selectedFiles.length} file(s), ` +
				`select=${selectOutcome}, install=${installOutcome}, run=${runOutcome}`,
		);
		console.log("::endgroup::");
	}

	return {
		infrastructureFailures,
		linters,
	};
}

function installLinterTools({
	applyWorkflowEnvironmentImpl,
	execFileSyncImpl,
	executionEnv,
	linterName,
	linterServicePath,
	runnerTemp,
}) {
	const envDir = path.join(
		runnerTemp,
		"linter-batch",
		linterName,
		"workflow-env",
	);
	const githubEnvPath = path.join(envDir, "github-env.txt");
	const githubPathPath = path.join(envDir, "github-path.txt");
	const installPath = path.join(linterServicePath, linterName, "install.sh");

	fs.rmSync(envDir, { force: true, recursive: true });
	fs.mkdirSync(envDir, { recursive: true });

	const installEnv = {
		...executionEnv,
		GITHUB_ENV: githubEnvPath,
		GITHUB_PATH: githubPathPath,
	};

	execFileSyncImpl("bash", [installPath], {
		cwd: linterServicePath,
		encoding: "utf8",
		env: installEnv,
	});

	return applyWorkflowEnvironmentImpl(installEnv, {
		githubEnvPath,
		githubPathPath,
	});
}

function parseLinterNames(input) {
	const parsed = JSON.parse(input);

	if (
		!Array.isArray(parsed) ||
		parsed.some((name) => typeof name !== "string")
	) {
		throw new Error("LINTER_NAMES_JSON must be a JSON array of strings");
	}

	return parsed;
}

function readLines(filePath) {
	if (!fs.existsSync(filePath)) {
		return [];
	}

	return fs
		.readFileSync(filePath, "utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function logStepFailure(stepName, linterName, error) {
	const details = formatExecError(error);
	console.error(`::warning::${linterName} ${stepName} step failed${details}`);
}

function formatExecError(error) {
	if (!error || typeof error !== "object") {
		return "";
	}

	const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
	const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
	const message = typeof error.message === "string" ? error.message.trim() : "";
	const details = [message, stdout, stderr].filter(Boolean).join("\n");

	return details.length > 0 ? `\n${details}` : "";
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
	formatExecError,
	installLinterTools,
	parseLinterNames,
	runFromEnv,
	runLinterBatch,
};
