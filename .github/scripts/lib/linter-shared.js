const fs = require("node:fs");

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

function readTargetKind(linterConfig) {
	return linterConfig?.sarif?.target_kind === "cargo-projects"
		? "cargo-project"
		: "file";
}

function deriveTargetCount({ checkedProjects, selectedFiles, targetKind }) {
	if (targetKind === "cargo-project") {
		return checkedProjects.length > 0
			? checkedProjects.length
			: selectedFiles.length;
	}

	return selectedFiles.length > 0
		? selectedFiles.length
		: checkedProjects.length;
}

function normalizeOptionalCount(value) {
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeStringArray(values) {
	return Array.isArray(values)
		? values.filter(
				(value) => typeof value === "string" && value.trim().length > 0,
			)
		: [];
}

function formatTargetLabel(targetKind, count) {
	if (targetKind === "cargo-project") {
		return count === 1 ? "Cargo project" : "Cargo projects";
	}

	return count === 1 ? "file" : "files";
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

module.exports = {
	deriveTargetCount,
	escapeHtml,
	formatTargetLabel,
	normalizeOptionalCount,
	normalizeStringArray,
	readLinterConfig,
	readResult,
	readSelectedFiles,
	readTargetKind,
};
