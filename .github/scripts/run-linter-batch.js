const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const requireEnv = require("./lib/require-env.js");

const {
	buildReportSummary,
	renderReport,
} = require("./render-linter-report.js");
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
		const linterResult = runSingleLinter({
			applyWorkflowEnvironmentImpl,
			contextPath,
			execFileSyncImpl,
			executionEnv,
			linterConfigPath,
			linterName,
			linterServicePath,
			renderReportImpl,
			renderSarifImpl,
			runnerTemp,
			selectLintTargetsImpl,
			sourceRepositoryPath,
		});
		executionEnv = linterResult.executionEnv;
		infrastructureFailures += linterResult.infrastructureFailures;
		linters.push(linterResult.linter);
	}

	return {
		infrastructureFailures,
		linters,
	};
}

function runSingleLinter({
	applyWorkflowEnvironmentImpl,
	contextPath,
	execFileSyncImpl,
	executionEnv,
	linterConfigPath,
	linterName,
	linterServicePath,
	renderReportImpl,
	renderSarifImpl,
	runnerTemp,
	selectLintTargetsImpl,
	sourceRepositoryPath,
}) {
	console.log(`::group::${linterName}`);
	const paths = createLinterPaths({ linterName, runnerTemp });
	let infrastructureFailures = 0;
	let selectOutcome = "success";
	let installOutcome = "skipped";
	let runOutcome = "skipped";
	let exitCodeRaw = "";

	resetLinterWorkspace(paths);

	try {
		selectLinterTargets({
			contextPath,
			execFileSyncImpl,
			executionEnv,
			linterName,
			linterServicePath,
			paths,
			selectLintTargetsImpl,
			sourceRepositoryPath,
		});
	} catch (error) {
		selectOutcome = "failure";
		infrastructureFailures += 1;
		logStepFailure("select", linterName, error);
	}

	const selectedFiles = readLines(paths.selectedFilesPath);
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
			exitCodeRaw = runLinter({
				execFileSyncImpl,
				executionEnv,
				linterName,
				linterServicePath,
				resultPath: paths.resultPath,
				selectedFiles,
				sourceRepositoryPath,
			});
			runOutcome = "success";
		} catch (error) {
			runOutcome = "failure";
			infrastructureFailures += 1;
			logStepFailure("run", linterName, error);
		}
	}

	let linter;

	try {
		linter = renderLinterArtifacts({
			configPath: linterConfigPath,
			exitCodeRaw,
			installOutcome,
			linterName,
			paths,
			renderReportImpl,
			renderSarifImpl,
			runOutcome,
			runnerTemp,
			selectOutcome,
			selectedFiles,
			sourceRepositoryPath,
		});
	} catch (error) {
		infrastructureFailures += 1;
		logStepFailure("render", linterName, error);
		linter = {
			conclusion: "failure",
			exitCodeRaw,
			installOutcome,
			linterName,
			resultPath: paths.resultPath,
			runOutcome,
			sarifProduced: false,
			selectOutcome,
			selectedFiles,
		};
	}

	console.log(
		`${linterName}: selected ${selectedFiles.length} file(s), ` +
			`select=${selectOutcome}, install=${installOutcome}, run=${runOutcome}`,
	);
	console.log("::endgroup::");

	return {
		executionEnv,
		infrastructureFailures,
		linter,
	};
}

function createLinterPaths({ linterName, runnerTemp }) {
	const workDir = path.join(runnerTemp, "linter-batch", linterName);

	return {
		patternPath: path.join(workDir, "patterns.txt"),
		resultPath: path.join(workDir, "linter-result.json"),
		sarifPath: path.join(runnerTemp, `linter-sarif-${linterName}.sarif`),
		selectedFilesPath: path.join(workDir, "selected-files.txt"),
		summaryPath: path.join(runnerTemp, `linter-summary-${linterName}.json`),
		workDir,
	};
}

function resetLinterWorkspace(paths) {
	fs.rmSync(paths.workDir, { force: true, recursive: true });
	fs.mkdirSync(paths.workDir, { recursive: true });
	fs.rmSync(paths.summaryPath, { force: true });
	fs.rmSync(paths.sarifPath, { force: true });
}

function selectLinterTargets({
	contextPath,
	execFileSyncImpl,
	executionEnv,
	linterName,
	linterServicePath,
	paths,
	selectLintTargetsImpl,
	sourceRepositoryPath,
}) {
	const patterns = execFileSyncImpl(
		"bash",
		[path.join(linterServicePath, linterName, "patterns.sh")],
		{
			cwd: linterServicePath,
			encoding: "utf8",
			env: executionEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	fs.writeFileSync(paths.patternPath, patterns, "utf8");
	selectLintTargetsImpl({
		...executionEnv,
		CONTEXT_PATH: contextPath,
		LINTER_NAME: linterName,
		OUTPUT_PATH: paths.selectedFilesPath,
		PATTERN_PATH: paths.patternPath,
		SOURCE_REPOSITORY_PATH: sourceRepositoryPath,
	});
}

function runLinter({
	execFileSyncImpl,
	executionEnv,
	linterName,
	linterServicePath,
	resultPath,
	selectedFiles,
	sourceRepositoryPath,
}) {
	const output = execFileSyncImpl(
		"bash",
		[path.join(linterServicePath, linterName, "run.sh"), ...selectedFiles],
		{
			cwd: sourceRepositoryPath,
			encoding: "utf8",
			env: executionEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	fs.writeFileSync(resultPath, output, "utf8");
	const parsed = JSON.parse(output);

	if (!Number.isInteger(parsed.exit_code)) {
		throw new Error(
			`${linterName} run.sh output must include integer exit_code`,
		);
	}

	return String(parsed.exit_code);
}

function renderLinterArtifacts({
	configPath,
	exitCodeRaw,
	installOutcome,
	linterName,
	paths,
	renderReportImpl,
	renderSarifImpl,
	runOutcome,
	runnerTemp,
	selectOutcome,
	selectedFiles,
	sourceRepositoryPath,
}) {
	const sarifReport = renderSarifImpl({
		configPath,
		installOutcome,
		linterName,
		outputPath: paths.sarifPath,
		resultPath: paths.resultPath,
		runnerTemp,
		runOutcome,
		selectedFilesPath: paths.selectedFilesPath,
		selectOutcome,
		sourceRepositoryPath,
	});
	const report = renderReportImpl({
		configPath,
		exitCodeRaw,
		installOutcome,
		linterName,
		resultPath: paths.resultPath,
		runOutcome,
		selectedFilesPath: paths.selectedFilesPath,
		selectOutcome,
		sourceRepositoryPath,
		targetStats: sarifReport.targetStats,
	});

	fs.writeFileSync(
		paths.summaryPath,
		JSON.stringify(
			buildReportSummary({
				...report,
				linterName,
				targetStats: sarifReport.targetStats,
			}),
			null,
			2,
		),
		"utf8",
	);

	if (sarifReport.produced) {
		fs.writeFileSync(
			sarifReport.outputPath,
			JSON.stringify(sarifReport.sarif, null, 2),
			"utf8",
		);
	}

	return {
		conclusion: report.conclusion,
		exitCodeRaw,
		installOutcome,
		linterName,
		resultPath: paths.resultPath,
		runOutcome,
		sarifProduced: sarifReport.produced,
		selectOutcome,
		selectedFiles,
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
		stdio: ["ignore", "pipe", "pipe"],
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

	const stdoutLength = summarizeCapturedOutput(error.stdout);
	const stderrLength = summarizeCapturedOutput(error.stderr);
	const message = sanitizeErrorMessage(error.message);
	const details = [message].filter(Boolean);

	if (stdoutLength > 0) {
		details.push(`stdout omitted (${stdoutLength} chars)`);
	}

	if (stderrLength > 0) {
		details.push(`stderr omitted (${stderrLength} chars)`);
	}

	return details.length > 0 ? `\n${details.join("\n")}` : "";
}

function sanitizeErrorMessage(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.split(/\r?\n/u, 1)[0].trim();
}

function summarizeCapturedOutput(value) {
	return typeof value === "string" ? value.trim().length : 0;
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
