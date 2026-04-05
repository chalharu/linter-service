const fs = require("node:fs");

const { validateLintersConfig } = require("../validate-linters-config.js");

function listLinterConfigs(configData) {
	if (
		!configData ||
		!configData.linters ||
		typeof configData.linters !== "object" ||
		Array.isArray(configData.linters)
	) {
		throw new Error("linters config must include a linters object");
	}

	return Object.entries(configData.linters).map(([name, value]) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${name} must be configured as an object`);
		}

		return {
			...value,
			name,
		};
	});
}

function readLintersConfig(configPath) {
	return validateLintersConfig({ configPath }).config;
}

function readLinterConfig(configPath, linterName) {
	const configData = readLintersConfig(configPath);
	const config = listLinterConfigs(configData).find(
		(item) => item.name === linterName,
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
	listLinterConfigs,
	readLintersConfig,
	normalizeOptionalCount,
	normalizeStringArray,
	readLinterConfig,
	readResult,
	readSelectedFiles,
	readTargetKind,
};
