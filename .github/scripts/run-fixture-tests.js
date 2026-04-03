const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	isLinterEnabled,
	loadLinterServiceConfig,
} = require("./linter-service-config.js");
const { renderReport } = require("./render-linter-report.js");
const { renderSarif } = require("./render-linter-sarif.js");
const { selectFiles } = require("./linter-targeting.js");

function runCli(argv = process.argv.slice(2), env = process.env) {
	const options = parseArgs(argv);
	return runFixtureTests({
		linterNames: options.linterNames,
		repositoryPath: env.GITHUB_WORKSPACE || process.cwd(),
		write: options.write,
	});
}

function runFixtureTests({ linterNames, repositoryPath, write = false }) {
	const resolvedRepositoryPath = path.resolve(repositoryPath);
	const config = JSON.parse(
		fs.readFileSync(path.join(resolvedRepositoryPath, "linters.json"), "utf8"),
	);
	const availableLinters = Array.isArray(config.linters)
		? config.linters
				.filter((entry) => entry && typeof entry.name === "string")
				.map((entry) => entry.name)
		: [];
	const requestedLinters =
		Array.isArray(linterNames) && linterNames.length > 0
			? linterNames
			: availableLinters;
	const results = [];

	for (const linterName of requestedLinters) {
		if (!availableLinters.includes(linterName)) {
			throw new Error(`unknown linter fixture suite: ${linterName}`);
		}

		results.push(
			runLinterFixtureSuite({
				linterName,
				repositoryPath: resolvedRepositoryPath,
				write,
			}),
		);
	}

	return {
		linters: results,
		write,
	};
}

function runLinterFixtureSuite({ linterName, repositoryPath, write }) {
	const fixtureNames = listFixtureNames(repositoryPath, linterName);

	if (fixtureNames.length < 2) {
		throw new Error(
			`${linterName} must include at least 2 fixture tests under ${linterName}/tests`,
		);
	}

	const installState = installLinterTools({
		linterName,
		repositoryPath,
	});
	const fixtures = fixtureNames.map((fixtureName) =>
		runFixtureCase({
			executionEnv: installState.executionEnv,
			fixtureName,
			linterName,
			repositoryPath,
			write,
		}),
	);

	return {
		fixtures,
		linterName,
	};
}

function listFixtureNames(repositoryPath, linterName) {
	const fixtureRoot = path.join(repositoryPath, linterName, "tests");

	if (!fs.existsSync(fixtureRoot)) {
		return [];
	}

	return fs
		.readdirSync(fixtureRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function installLinterTools({ linterName, repositoryPath }) {
	const runnerTemp = fs.mkdtempSync(
		path.join(os.tmpdir(), `${linterName}-fixture-install-`),
	);
	const githubPathPath = path.join(runnerTemp, "github-path.txt");
	const githubEnvPath = path.join(runnerTemp, "github-env.txt");
	const installPath = path.join(repositoryPath, linterName, "install.sh");
	const installEnv = {
		...process.env,
		GITHUB_ENV: githubEnvPath,
		GITHUB_PATH: githubPathPath,
		RUNNER_TEMP: runnerTemp,
	};

	execFileSync("bash", [installPath], {
		cwd: repositoryPath,
		encoding: "utf8",
		env: installEnv,
	});

	return {
		executionEnv: applyWorkflowEnvironment(installEnv, {
			githubEnvPath,
			githubPathPath,
		}),
	};
}

function applyWorkflowEnvironment(baseEnv, { githubEnvPath, githubPathPath }) {
	const nextEnv = { ...baseEnv };

	if (fs.existsSync(githubPathPath)) {
		const pathEntries = fs
			.readFileSync(githubPathPath, "utf8")
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);

		if (pathEntries.length > 0) {
			nextEnv.PATH = `${pathEntries.join(path.delimiter)}${path.delimiter}${baseEnv.PATH}`;
		}
	}

	if (fs.existsSync(githubEnvPath)) {
		for (const line of fs
			.readFileSync(githubEnvPath, "utf8")
			.split(/\r?\n/u)
			.filter(Boolean)) {
			const separator = line.indexOf("=");

			if (separator <= 0) {
				continue;
			}

			nextEnv[line.slice(0, separator)] = line.slice(separator + 1);
		}
	}

	delete nextEnv.GITHUB_ENV;
	delete nextEnv.GITHUB_PATH;

	return nextEnv;
}

function runFixtureCase({
	executionEnv,
	fixtureName,
	linterName,
	repositoryPath,
	write,
}) {
	const fixtureRoot = path.join(
		repositoryPath,
		linterName,
		"tests",
		fixtureName,
	);
	const targetRoot = path.join(fixtureRoot, "target");
	const expectedResultPath = path.join(fixtureRoot, "result.json");
	const expectedSarifPath = path.join(fixtureRoot, "sarif.json");
	const caseRunnerTemp = fs.mkdtempSync(
		path.join(os.tmpdir(), `${linterName}-${fixtureName}-fixture-`),
	);
	const caseRepositoryPath = path.join(caseRunnerTemp, "repo");

	if (!fs.existsSync(targetRoot)) {
		throw new Error(
			`${linterName}/${fixtureName} must include a target/ directory`,
		);
	}

	copyFixtureTarget(targetRoot, caseRepositoryPath);
	initializeGitRepository(caseRepositoryPath);

	const candidatePaths = listTrackedFiles(caseRepositoryPath);
	const patternStrings = runPatternScript({
		linterName,
		repositoryPath,
		executionEnv,
	});
	const serviceConfig = loadLinterServiceConfig({
		repositoryPath: caseRepositoryPath,
	});
	const selectedFiles = isLinterEnabled(serviceConfig, linterName)
		? selectFiles({
				candidatePaths,
				linterName,
				patterns: patternStrings,
				serviceConfig,
			})
		: [];
	const selectedFilesPath = path.join(caseRunnerTemp, "selected-files.txt");
	const resultPath = path.join(caseRunnerTemp, "linter-result.json");
	const sarifPath = path.join(caseRunnerTemp, "linter.sarif");

	fs.writeFileSync(
		selectedFilesPath,
		selectedFiles.length > 0 ? `${selectedFiles.join("\n")}\n` : "",
		"utf8",
	);

	if (selectedFiles.length > 0) {
		const runOutput = execFileSync(
			"bash",
			[path.join(repositoryPath, linterName, "run.sh"), ...selectedFiles],
			{
				cwd: caseRepositoryPath,
				encoding: "utf8",
				env: {
					...executionEnv,
					RUNNER_TEMP: caseRunnerTemp,
				},
			},
		);

		fs.writeFileSync(resultPath, runOutput, "utf8");
	}

	const parsedResult = fs.existsSync(resultPath)
		? JSON.parse(fs.readFileSync(resultPath, "utf8"))
		: null;
	const report = renderReport({
		configPath: path.join(repositoryPath, "linters.json"),
		exitCodeRaw:
			parsedResult && Number.isInteger(parsedResult.exit_code)
				? String(parsedResult.exit_code)
				: "",
		installOutcome: "success",
		linterName,
		resultPath,
		runOutcome: selectedFiles.length > 0 ? "success" : "skipped",
		selectedFilesPath,
		selectOutcome: "success",
		sourceRepositoryPath: caseRepositoryPath,
	});
	const sarifReport = renderSarif({
		configPath: path.join(repositoryPath, "linters.json"),
		installOutcome: "success",
		linterName,
		outputPath: sarifPath,
		resultPath,
		runnerTemp: caseRunnerTemp,
		runOutcome: selectedFiles.length > 0 ? "success" : "skipped",
		selectedFilesPath,
		selectOutcome: "success",
		sourceRepositoryPath: caseRepositoryPath,
	});
	const actualResult = normalizeFixtureResult({
		report,
		repositoryPath: caseRepositoryPath,
		result: parsedResult,
	});
	const actualSarif = normalizeSarif(
		sarifReport.produced ? sarifReport.sarif : null,
		caseRepositoryPath,
	);

	if (write) {
		writeJsonFixture(expectedResultPath, actualResult);
		writeJsonFixture(expectedSarifPath, actualSarif);
	} else {
		assertJsonFixture(actualResult, expectedResultPath);
		assertJsonFixture(actualSarif, expectedSarifPath);
	}

	return {
		fixtureName,
		linterName,
		selectedFiles,
	};
}

function runPatternScript({ executionEnv, linterName, repositoryPath }) {
	return execFileSync(
		"bash",
		[path.join(repositoryPath, linterName, "patterns.sh")],
		{
			cwd: repositoryPath,
			encoding: "utf8",
			env: executionEnv,
		},
	)
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function normalizeFixtureResult({ report, repositoryPath, result }) {
	return sortKeysDeep({
		checked_projects: [...report.checkedProjects]
			.map((entry) => sanitizeFixtureString(entry, repositoryPath))
			.sort(),
		result: sanitizeFixtureValue(result, repositoryPath),
		selected_files: [...report.selectedFiles]
			.map((entry) => sanitizeFixtureString(entry, repositoryPath))
			.sort(),
	});
}

function sanitizeFixtureValue(value, repositoryPath) {
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeFixtureValue(entry, repositoryPath));
	}

	if (!value || typeof value !== "object") {
		return typeof value === "string"
			? sanitizeFixtureString(value, repositoryPath)
			: value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			sanitizeFixtureValue(entry, repositoryPath),
		]),
	);
}

function sanitizeFixtureString(value, repositoryPath) {
	let normalized = value;

	if (repositoryPath) {
		const repositoryPathPosix = repositoryPath.split(path.sep).join("/");
		normalized = normalized.split(`${repositoryPathPosix}/`).join("");
		normalized = normalized.split(repositoryPathPosix).join(".");
	}

	return normalized
		.replace(
			/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d\d:\d\d:\d\d(?:\.\d+)?\b/gu,
			"<timestamp>",
		)
		.replace(
			/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/gu,
			"<timestamp>",
		)
		.replace(/\b\d+(?:\.\d+)?(?:ns|us|µs|ms|s|min)\b/gu, "<duration>");
}

function normalizeSarif(sarif, repositoryPath) {
	if (sarif === null) {
		return null;
	}

	const normalized = sanitizeFixtureValue(
		structuredClone(sarif),
		repositoryPath,
	);

	if (Array.isArray(normalized.runs)) {
		normalized.runs = normalized.runs.map((run) => {
			if (Array.isArray(run.results)) {
				run.results = [...run.results]
					.map((result) => {
						const sanitizedResult = { ...result };
						delete sanitizedResult.partialFingerprints;
						return sortKeysDeep(sanitizedResult);
					})
					.sort(compareSarifResults);
			}

			if (Array.isArray(run.tool?.driver?.rules)) {
				run.tool.driver.rules = [...run.tool.driver.rules]
					.map(sortKeysDeep)
					.sort(compareSarifRules);
			}

			return sortKeysDeep(run);
		});
	}

	return sortKeysDeep(normalized);
}

function compareSarifResults(left, right) {
	return buildSarifResultKey(left).localeCompare(buildSarifResultKey(right));
}

function buildSarifResultKey(result) {
	const location = result.locations?.[0]?.physicalLocation;
	const uri = location?.artifactLocation?.uri || "";
	const line = String(location?.region?.startLine || "");
	const column = String(location?.region?.startColumn || "");
	return [
		result.ruleId || "",
		result.level || "",
		uri,
		line,
		column,
		result.message?.text || "",
	].join("\u0000");
}

function compareSarifRules(left, right) {
	return `${left.id || ""}\u0000${left.name || ""}`.localeCompare(
		`${right.id || ""}\u0000${right.name || ""}`,
	);
}

function sortKeysDeep(value) {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const sorted = {};

	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortKeysDeep(value[key]);
	}

	return sorted;
}

function assertJsonFixture(actualValue, expectedPath) {
	if (!fs.existsSync(expectedPath)) {
		throw new Error(`missing expected fixture file: ${expectedPath}`);
	}

	const expectedValue = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
	assert.deepStrictEqual(actualValue, expectedValue);
}

function writeJsonFixture(outputPath, value) {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		`${outputPath}`,
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

function copyFixtureTarget(sourceRoot, targetRoot) {
	fs.mkdirSync(targetRoot, { recursive: true });

	for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
		fs.cpSync(
			path.join(sourceRoot, entry.name),
			path.join(targetRoot, entry.name),
			{
				recursive: true,
			},
		);
	}
}

function initializeGitRepository(repositoryPath) {
	execFileSync("git", ["init", "--initial-branch=main"], {
		cwd: repositoryPath,
		encoding: "utf8",
	});
	execFileSync("git", ["add", "-A", "."], {
		cwd: repositoryPath,
		encoding: "utf8",
	});
}

function listTrackedFiles(repositoryPath) {
	const output = execFileSync("git", ["ls-files"], {
		cwd: repositoryPath,
		encoding: "utf8",
	});

	return output.split(/\r?\n/u).filter(Boolean);
}

function parseArgs(argv) {
	const linterNames = [];
	let write = false;

	for (const arg of argv) {
		if (arg === "--write") {
			write = true;
			continue;
		}

		linterNames.push(arg);
	}

	return {
		linterNames,
		write,
	};
}

if (require.main === module) {
	runCli(process.argv.slice(2), process.env);
}

module.exports = {
	applyWorkflowEnvironment,
	listFixtureNames,
	normalizeFixtureResult,
	normalizeSarif,
	parseArgs,
	runFixtureCase,
	runFixtureTests,
	runLinterFixtureSuite,
	runCli,
	writeJsonFixture,
};
