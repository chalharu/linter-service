const fs = require("node:fs");
const path = require("node:path");

const CARGO_LINTERS = new Set(["cargo-clippy", "cargo-fmt"]);
const MAX_RENDERED_PATHS = 100;
const DETAILS_LIMIT = 60000;

function runFromEnv(env = process.env) {
	const linterName = requireEnv(env, "LINTER_NAME");
	const runnerTemp = requireEnv(env, "RUNNER_TEMP");
	const report = renderReport({
		configPath: requireEnv(env, "LINTER_CONFIG_PATH"),
		exitCodeRaw: env.EXIT_CODE ?? "",
		installOutcome: env.INSTALL_TOOL_OUTCOME ?? "",
		linterName,
		resultPath: requireEnv(env, "RESULT_PATH"),
		runOutcome: env.RUN_LINTER_OUTCOME ?? "",
		selectedFilesPath: requireEnv(env, "SELECTED_FILES_PATH"),
		selectOutcome: env.SELECT_FILES_OUTCOME ?? "",
		sourceRepositoryPath: requireEnv(env, "SOURCE_REPOSITORY_PATH"),
	});

	writeReportFiles({
		body: report.body,
		conclusion: report.conclusion,
		linterName,
		runnerTemp,
	});

	return report;
}

function renderReport({
	configPath,
	exitCodeRaw,
	installOutcome,
	linterName,
	resultPath,
	runOutcome,
	selectedFilesPath,
	selectOutcome,
	sourceRepositoryPath,
}) {
	const linterConfig = readLinterConfig(configPath, linterName);
	const selectedFiles = readSelectedFiles(selectedFilesPath);
	const checkedProjects = collectProjectTargets(
		linterName,
		sourceRepositoryPath,
		selectedFiles,
	);
	const targetLines = buildTargetLines(selectedFiles, checkedProjects);
	const result = readResult(resultPath);
	const hasStepFailure = [selectOutcome, installOutcome, runOutcome].includes(
		"failure",
	);
	const success =
		!hasStepFailure && (selectedFiles.length === 0 || exitCodeRaw === "0");
	const conclusion = success ? "success" : "failure";
	const lines = [linterConfig.heading, ""];

	if (hasStepFailure && result === null) {
		lines.push(linterConfig.infra_failure);
		appendTargetLines(lines, targetLines);
	} else if (selectedFiles.length === 0 && exitCodeRaw === "") {
		lines.push(linterConfig.no_files);
	} else if (success) {
		lines.push(linterConfig.success);
		appendTargetLines(lines, targetLines);
	} else {
		lines.push(linterConfig.failure);
		appendTargetLines(lines, targetLines);
		lines.push(
			"",
			"<details><summary>Details</summary>",
			"",
			"```text",
			resolveDetails(result, linterConfig.details_fallback),
			"```",
			"</details>",
		);
	}

	return {
		body: `${lines.join("\n")}\n`,
		checkedProjects,
		conclusion,
		selectedFiles,
	};
}

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

function readLinterConfig(configPath, linterName) {
	const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const linters = Array.isArray(configData.linters) ? configData.linters : [];
	const config = linters.find(
		(item) => item && typeof item.name === "string" && item.name === linterName,
	);

	if (!config) {
		throw new Error(`unsupported linter: ${linterName}`);
	}

	return config;
}

function readSelectedFiles(selectedFilesPath) {
	if (!fs.existsSync(selectedFilesPath)) {
		return [];
	}

	return fs
		.readFileSync(selectedFilesPath, "utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function readResult(resultPath) {
	if (!fs.existsSync(resultPath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(resultPath, "utf8"));
	} catch {
		return null;
	}
}

function resolveDetails(result, fallback) {
	const details =
		result && typeof result.details === "string" ? result.details.trim() : "";

	if (details.length === 0) {
		return fallback;
	}

	if (details.length > DETAILS_LIMIT) {
		return `${details.slice(0, DETAILS_LIMIT)}\n... truncated ...`;
	}

	return details;
}

function appendTargetLines(lines, targetLines) {
	if (targetLines.length === 0) {
		return;
	}

	lines.push("", ...targetLines);
}

function buildTargetLines(selectedFiles, checkedProjects) {
	const lines = [];

	if (selectedFiles.length > 0) {
		lines.push(...formatPathSection("Target file paths", selectedFiles));
	}

	if (checkedProjects.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}

		lines.push(...formatPathSection("Cargo project targets", checkedProjects));
	}

	return lines;
}

function formatPathSection(title, paths) {
	const displayedPaths = paths.slice(0, MAX_RENDERED_PATHS);
	const lines = [`${title}:`];

	for (const currentPath of displayedPaths) {
		lines.push(`- <code>${escapeHtml(currentPath)}</code>`);
	}

	if (paths.length > displayedPaths.length) {
		lines.push(
			`- ... ${paths.length - displayedPaths.length} more path(s) omitted`,
		);
	}

	return lines;
}

function collectProjectTargets(
	linterName,
	sourceRepositoryPath,
	selectedFiles,
) {
	if (!CARGO_LINTERS.has(linterName)) {
		return [];
	}

	const manifests = [];
	const seen = new Set();

	for (const selectedFile of selectedFiles) {
		const manifestPath = findNearestCargoManifest(
			sourceRepositoryPath,
			selectedFile,
		);

		if (manifestPath && !seen.has(manifestPath)) {
			seen.add(manifestPath);
			manifests.push(manifestPath);
		}
	}

	return manifests;
}

function findNearestCargoManifest(sourceRepositoryPath, filePath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	let currentDir = path.resolve(repoRoot, path.dirname(filePath));

	if (!isWithinRoot(repoRoot, currentDir)) {
		return null;
	}

	while (isWithinRoot(repoRoot, currentDir)) {
		const candidate = path.join(currentDir, "Cargo.toml");

		if (fs.existsSync(candidate)) {
			return normalizePath(path.relative(repoRoot, candidate) || "Cargo.toml");
		}

		if (currentDir === repoRoot) {
			return null;
		}

		const parentDir = path.dirname(currentDir);

		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}

	return null;
}

function isWithinRoot(rootPath, candidatePath) {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function normalizePath(filePath) {
	return filePath.replace(/\\/gu, "/");
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function writeReportFiles({ body, conclusion, linterName, runnerTemp }) {
	const commentPath = path.join(runnerTemp, "linter-comment.md");
	const summaryPath = path.join(
		runnerTemp,
		`linter-summary-${linterName}.json`,
	);

	fs.writeFileSync(commentPath, body, "utf8");
	fs.writeFileSync(
		summaryPath,
		JSON.stringify(
			{
				comment_body: body,
				conclusion,
				linter_name: linterName,
			},
			null,
			2,
		),
		"utf8",
	);
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	collectProjectTargets,
	findNearestCargoManifest,
	renderReport,
	runFromEnv,
};
