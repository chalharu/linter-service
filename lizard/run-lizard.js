const { spawnSync } = require("node:child_process");

const {
	getLinterConfig,
	loadLinterServiceConfig,
	normalizeRelativePath,
} = require("../.github/scripts/linter-service-config.js");
const { detectLanguage, SUPPORTED_LANGUAGES } = require("./language-config.js");

const THRESHOLD_KEYS = Object.freeze([
	"nloc",
	"cyclomatic_complexity",
	"token_count",
	"parameter_count",
	"length",
]);
const WARNING_PATTERN =
	/^(?<path>.+?):(?<line>\d+): warning: (?<function>.+?) has (?<metrics>.+)$/u;

function runFromCli(argv = process.argv.slice(2), env = process.env) {
	const repositoryPath = resolveRepositoryPath(env);
	const result = runConfiguredLizard({
		env,
		filePaths: argv,
		repositoryPath,
	});

	if (result.details.length > 0) {
		process.stdout.write(`${result.details}\n`);
	}

	process.exitCode = result.exitCode;
	return result;
}

function resolveRepositoryPath(env = process.env) {
	if (
		typeof env.SOURCE_REPOSITORY_PATH === "string" &&
		env.SOURCE_REPOSITORY_PATH.length > 0
	) {
		return env.SOURCE_REPOSITORY_PATH;
	}

	return process.cwd();
}

function runConfiguredLizard({
	env = process.env,
	filePaths,
	repositoryPath = resolveRepositoryPath(env),
	serviceConfig,
	spawnSyncImpl = spawnSync,
}) {
	const normalizedFilePaths = Array.isArray(filePaths)
		? filePaths.map((filePath) => normalizeRelativePath(filePath))
		: [];

	if (normalizedFilePaths.length === 0) {
		return {
			details: "",
			exitCode: 0,
		};
	}

	const loadedConfig =
		serviceConfig || loadLinterServiceConfig({ repositoryPath });
	const lizardConfig = getLinterConfig(loadedConfig, "lizard");
	const runPlan = buildLanguageRunPlan({
		configuredLanguages: lizardConfig.languages,
		filePaths: normalizedFilePaths,
		thresholdsByLanguage: lizardConfig.thresholds || {},
	});
	const details = [];
	let exitCode = 0;

	for (const currentPlan of runPlan) {
		const result = runLizardGroup({
			env,
			filePaths: currentPlan.filePaths,
			repositoryPath,
			spawnSyncImpl,
			thresholds: currentPlan.thresholds,
		});
		const normalizedOutput = normalizeLizardOutput(result.output, {
			usesCustomThresholds: Object.keys(currentPlan.thresholds).length > 0,
		});

		if (normalizedOutput.length > 0) {
			details.push(normalizedOutput);
		}

		exitCode = Math.max(exitCode, result.exitCode);
	}

	return {
		details: details.join("\n"),
		exitCode,
	};
}

function buildLanguageRunPlan({
	configuredLanguages,
	filePaths,
	thresholdsByLanguage = {},
}) {
	const candidateLanguages =
		Array.isArray(configuredLanguages) && configuredLanguages.length > 0
			? configuredLanguages
			: SUPPORTED_LANGUAGES;
	const groupedFiles = new Map(
		candidateLanguages.map((language) => [language, []]),
	);
	const fallbackFiles = [];

	for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
		const normalizedPath = normalizeRelativePath(filePath);
		const language = detectLanguage(normalizedPath, candidateLanguages);

		if (!language) {
			fallbackFiles.push(normalizedPath);
			continue;
		}

		groupedFiles.get(language).push(normalizedPath);
	}

	const runPlan = [];

	for (const language of candidateLanguages) {
		const languageFiles = groupedFiles.get(language);

		if (!Array.isArray(languageFiles) || languageFiles.length === 0) {
			continue;
		}

		runPlan.push({
			filePaths: languageFiles,
			language,
			thresholds: thresholdsByLanguage[language] || {},
		});
	}

	if (fallbackFiles.length > 0) {
		runPlan.push({
			filePaths: fallbackFiles,
			language: null,
			thresholds: {},
		});
	}

	return runPlan;
}

function buildThresholdArguments(thresholds = {}) {
	if (!thresholds || typeof thresholds !== "object") {
		return [];
	}

	const argumentsList = [];

	for (const thresholdKey of THRESHOLD_KEYS) {
		if (!Number.isInteger(thresholds[thresholdKey])) {
			continue;
		}

		switch (thresholdKey) {
			case "nloc":
				argumentsList.push("-T", `nloc=${thresholds[thresholdKey]}`);
				break;
			case "cyclomatic_complexity":
				argumentsList.push("-C", String(thresholds[thresholdKey]));
				break;
			case "token_count":
				argumentsList.push("-T", `token_count=${thresholds[thresholdKey]}`);
				break;
			case "parameter_count":
				argumentsList.push("-a", String(thresholds[thresholdKey]));
				break;
			case "length":
				argumentsList.push("-L", String(thresholds[thresholdKey]));
				break;
			default:
				break;
		}
	}

	return argumentsList;
}

function runLizardGroup({
	env = process.env,
	filePaths,
	repositoryPath,
	spawnSyncImpl = spawnSync,
	thresholds = {},
}) {
	if (!Array.isArray(filePaths) || filePaths.length === 0) {
		return {
			exitCode: 0,
			output: "",
		};
	}

	const result = spawnSyncImpl(
		"lizard",
		["-w", ...buildThresholdArguments(thresholds), ...filePaths],
		{
			cwd: repositoryPath,
			encoding: "utf8",
			env,
		},
	);

	if (result.error) {
		throw result.error;
	}

	if (!Number.isInteger(result.status)) {
		throw new Error("lizard did not produce an exit status");
	}

	const output = [result.stdout, result.stderr]
		.filter((entry) => typeof entry === "string" && entry.length > 0)
		.join("\n")
		.trim();

	if (result.status > 1) {
		throw new Error(
			output.length > 0 ? output : `lizard exited with status ${result.status}`,
		);
	}

	return {
		exitCode: result.status,
		output,
	};
}

function normalizeLizardOutput(output, { usesCustomThresholds = false } = {}) {
	return String(output)
		.split(/\r?\n/u)
		.map((line) => normalizeLizardWarning(line, { usesCustomThresholds }))
		.filter(Boolean)
		.join("\n");
}

function normalizeLizardWarning(line, { usesCustomThresholds = false } = {}) {
	const trimmed = String(line).trim();

	if (trimmed.length === 0) {
		return "";
	}

	const match = WARNING_PATTERN.exec(trimmed);

	if (!match?.groups) {
		return trimmed;
	}

	const filePath = normalizeRelativePath(match.groups.path);

	if (usesCustomThresholds) {
		return `${filePath}:${match.groups.line}: ${match.groups.function} exceeds configured lizard thresholds with ${match.groups.metrics}`;
	}

	const ccnMatch = /\b(?<ccn>\d+) CCN\b/u.exec(match.groups.metrics);
	if (!ccnMatch?.groups) {
		return `${filePath}:${match.groups.line}: warning: ${match.groups.function} has ${match.groups.metrics}`;
	}

	return `${filePath}:${match.groups.line}: ${match.groups.function} exceeds the CCN limit with ${ccnMatch.groups.ccn} CCN`;
}

if (require.main === module) {
	try {
		runFromCli(process.argv.slice(2), process.env);
	} catch (error) {
		const message =
			error instanceof Error && error.message.length > 0
				? error.message
				: String(error);

		if (message.length > 0) {
			process.stderr.write(`${message}\n`);
		}

		process.exitCode = 2;
	}
}

module.exports = {
	buildLanguageRunPlan,
	buildThresholdArguments,
	normalizeLizardOutput,
	runConfiguredLizard,
	runFromCli,
};
