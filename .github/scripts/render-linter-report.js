const fs = require("node:fs");
const path = require("node:path");

const CARGO_LINTERS = new Set(["cargo-clippy", "cargo-deny"]);
const CARGO_DENY_CONFIG_FILE = /(?:^|\/)\.cargo\/config(?:\.toml)?$/u;
const CARGO_DENY_POLICY_FILE = /(?:^|\/)deny\.toml$/u;
const MAX_INLINE_PATHS = 10;
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
		linterName,
		report,
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
	let detailsText = "";
	let status = "failure";
	let summaryText = "";

	if (hasStepFailure && result === null) {
		status = "infra_failure";
		summaryText = linterConfig.infra_failure;
		lines.push(summaryText);
		appendTargetLines(lines, targetLines);
	} else if (selectedFiles.length === 0 && exitCodeRaw === "") {
		status = "no_targets";
		summaryText = linterConfig.no_files;
		lines.push(summaryText);
	} else if (success) {
		status = "success";
		summaryText = linterConfig.success;
		lines.push(summaryText);
		appendTargetLines(lines, targetLines);
	} else {
		status = "failure";
		summaryText = linterConfig.failure;
		detailsText = resolveDetails(result, linterConfig.details_fallback);
		lines.push(summaryText);
		appendTargetLines(lines, targetLines);
		lines.push(
			"",
			"<details><summary>Details</summary>",
			"",
			"```text",
			detailsText,
			"```",
			"</details>",
		);
	}

	return {
		body: `${lines.join("\n")}\n`,
		checkedProjects,
		conclusion,
		detailsText,
		selectedFiles,
		status,
		summaryText,
		targetSummary: buildTargetSummary(selectedFiles, checkedProjects),
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

function buildTargetSummary(selectedFiles, checkedProjects) {
	const parts = [];

	if (selectedFiles.length > 0) {
		parts.push(`${selectedFiles.length} file(s)`);
	}

	if (checkedProjects.length > 0) {
		parts.push(`${checkedProjects.length} Cargo project(s)`);
	}

	return parts.length > 0 ? parts.join(", ") : "n/a";
}

function formatPathSection(title, paths) {
	const displayedPaths = paths.slice(0, MAX_RENDERED_PATHS);
	const pathLines = [];

	for (const currentPath of displayedPaths) {
		pathLines.push(`- <code>${escapeHtml(currentPath)}</code>`);
	}

	if (paths.length > displayedPaths.length) {
		pathLines.push(
			`- ... ${paths.length - displayedPaths.length} more path(s) omitted`,
		);
	}

	if (paths.length <= MAX_INLINE_PATHS) {
		return [`${title}:`, ...pathLines];
	}

	return [
		`${title}:`,
		"",
		`<details><summary>Show ${paths.length} path(s)</summary>`,
		"",
		...pathLines,
		"</details>",
	];
}

function collectProjectTargets(
	linterName,
	sourceRepositoryPath,
	selectedFiles,
) {
	if (!CARGO_LINTERS.has(linterName)) {
		return [];
	}

	if (linterName === "cargo-deny") {
		return collectCargoDenyProjectTargets(sourceRepositoryPath, selectedFiles);
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

function collectCargoDenyProjectTargets(sourceRepositoryPath, selectedFiles) {
	const allManifests = listCargoManifests(sourceRepositoryPath);
	const manifests = [];
	const seen = new Set();

	for (const selectedFile of selectedFiles.map((filePath) =>
		normalizePath(filePath),
	)) {
		let matchingManifests = [];

		if (CARGO_DENY_POLICY_FILE.test(selectedFile)) {
			matchingManifests = allManifests.filter(
				(manifestPath) =>
					findCargoDenyConfig(sourceRepositoryPath, manifestPath) ===
					selectedFile,
			);
		} else if (CARGO_DENY_CONFIG_FILE.test(selectedFile)) {
			matchingManifests = allManifests.filter((manifestPath) =>
				manifestUsesCargoConfig(manifestPath, selectedFile),
			);
		} else {
			const manifestPath = findNearestCargoManifest(
				sourceRepositoryPath,
				selectedFile,
			);

			if (manifestPath) {
				matchingManifests = [manifestPath];
			}
		}

		for (const manifestPath of matchingManifests) {
			if (!seen.has(manifestPath)) {
				seen.add(manifestPath);
				manifests.push(manifestPath);
			}
		}
	}

	return manifests;
}

function listCargoManifests(sourceRepositoryPath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	const manifests = [];
	const pendingDirs = [repoRoot];

	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		const entries = fs.readdirSync(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name === ".git") {
				continue;
			}

			const entryPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				pendingDirs.push(entryPath);
				continue;
			}

			if (entry.isFile() && entry.name === "Cargo.toml") {
				manifests.push(
					normalizePath(path.relative(repoRoot, entryPath) || "Cargo.toml"),
				);
			}
		}
	}

	return manifests.sort();
}

function findCargoDenyConfig(sourceRepositoryPath, manifestPath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	let currentDir = normalizePath(
		path.posix.dirname(normalizePath(manifestPath)),
	);

	while (true) {
		const candidate =
			currentDir === "." ? "deny.toml" : `${currentDir}/deny.toml`;

		if (fs.existsSync(path.join(repoRoot, candidate))) {
			return candidate;
		}

		if (currentDir === ".") {
			return null;
		}

		const parentDir = normalizePath(path.posix.dirname(currentDir));

		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

function manifestUsesCargoConfig(manifestPath, configPath) {
	const manifestDir = normalizePath(
		path.posix.dirname(normalizePath(manifestPath)),
	);
	const scopeDir = normalizePath(
		path.posix.dirname(path.posix.dirname(normalizePath(configPath))),
	);

	return (
		scopeDir === "." ||
		manifestDir === scopeDir ||
		manifestDir.startsWith(`${scopeDir}/`)
	);
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

function buildReportSummary({
	body,
	checkedProjects = [],
	conclusion,
	detailsText = "",
	linterName,
	selectedFiles = [],
	status,
	summaryText = "",
	targetSummary,
}) {
	return {
		checked_project_count: Array.isArray(checkedProjects)
			? checkedProjects.length
			: 0,
		comment_body: body,
		conclusion,
		details_text: detailsText,
		linter_name: linterName,
		selected_file_count: Array.isArray(selectedFiles)
			? selectedFiles.length
			: 0,
		status:
			typeof status === "string" && status.length > 0
				? status
				: conclusion === "success"
					? "success"
					: "failure",
		summary_text: summaryText,
		target_summary:
			typeof targetSummary === "string" && targetSummary.length > 0
				? targetSummary
				: "n/a",
	};
}

function writeReportFiles({ linterName, report, runnerTemp }) {
	const commentPath = path.join(runnerTemp, "linter-comment.md");
	const summaryPath = path.join(
		runnerTemp,
		`linter-summary-${linterName}.json`,
	);

	fs.writeFileSync(commentPath, report.body, "utf8");
	fs.writeFileSync(
		summaryPath,
		JSON.stringify(buildReportSummary({ ...report, linterName }), null, 2),
		"utf8",
	);
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	buildReportSummary,
	buildTargetSummary,
	collectProjectTargets,
	findNearestCargoManifest,
	renderReport,
	runFromEnv,
};
