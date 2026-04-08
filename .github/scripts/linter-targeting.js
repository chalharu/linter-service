const fs = require("node:fs");
const path = require("node:path");

const {
	filterExcludedPaths,
	isLinterEnabled,
	normalizeRelativePath,
} = require("./linter-service-config.js");
const { loadLinterHook } = require("./lib/linter-hooks.js");

const EXECUTION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function selectFiles({
	applyExcludes = true,
	candidatePaths,
	linterName,
	linterServicePath,
	patterns,
	repositoryPath,
	serviceConfig,
}) {
	const compiledPatterns = compilePatterns(patterns);
	const normalizedCandidates = candidatePaths.map(normalizeRelativePath);
	const filteredCandidates = applyExcludes
		? filterExcludedPaths(serviceConfig, linterName, normalizedCandidates)
		: normalizedCandidates;

	return applySelectedFilesHook({
		linterName,
		linterServicePath,
		repositoryPath,
		selectedFiles: filteredCandidates.filter((candidatePath) =>
			compiledPatterns.some((pattern) => pattern.test(candidatePath)),
		),
		serviceConfig,
	});
}

function hasPatternMatch({
	applyExcludes = true,
	candidatePaths,
	linterName,
	linterServicePath,
	patterns,
	repositoryPath,
	serviceConfig,
}) {
	if (!Array.isArray(patterns) || patterns.length === 0) {
		return false;
	}

	return (
		selectFiles({
			applyExcludes,
			candidatePaths,
			linterName,
			linterServicePath,
			patterns,
			repositoryPath,
			serviceConfig,
		}).length > 0
	);
}

function selectLinters({
	candidatePaths,
	definitions,
	linterServicePath,
	repositoryPath,
	serviceConfig,
}) {
	const selectedLinters = [];

	for (const definition of definitions) {
		validateDefinition(definition);

		if (
			!isLinterEnabled(serviceConfig, definition.name, {
				defaultDisabled: definition.default_disabled === true,
			})
		) {
			continue;
		}

		if (!hasRequiredRootFiles(definition, repositoryPath)) {
			continue;
		}

		if (
			hasPatternMatch({
				candidatePaths,
				linterName: definition.name,
				linterServicePath,
				patterns: definition.patterns,
				repositoryPath,
				serviceConfig,
			}) ||
			hasPatternMatch({
				candidatePaths,
				linterName: definition.name,
				linterServicePath,
				patterns: definition.config_trigger_patterns,
				applyExcludes: false,
				repositoryPath,
				serviceConfig,
			})
		) {
			selectedLinters.push(definition.name);
		}
	}

	return selectedLinters;
}

function applySelectedFilesHook({
	linterName,
	linterServicePath,
	repositoryPath,
	selectedFiles,
	serviceConfig,
}) {
	const hook = loadLinterHook({
		fileName: "filter-selected-files.js",
		linterName,
		linterServicePath,
	});

	if (typeof hook?.filterSelectedFiles !== "function") {
		return selectedFiles;
	}

	const filtered = hook.filterSelectedFiles({
		repositoryPath,
		selectedFiles,
		serviceConfig,
	});

	if (!Array.isArray(filtered)) {
		throw new Error(
			`${linterName} filter-selected-files.js must return an array of file paths`,
		);
	}

	return filtered.map(normalizeRelativePath);
}

function hasRequiredRootFiles(definition, repositoryPath) {
	if (!Array.isArray(definition.required_root_files)) {
		return true;
	}

	if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
		return false;
	}

	const resolvedRepositoryPath = path.resolve(repositoryPath);

	return definition.required_root_files.every((requiredPath) => {
		const normalized = normalizeRelativePath(requiredPath);
		const resolvedPath = path.resolve(resolvedRepositoryPath, normalized);
		const relativePath = path.relative(resolvedRepositoryPath, resolvedPath);

		return (
			relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath) &&
			fs.existsSync(resolvedPath)
		);
	});
}

function buildLinterJobAssignments({ definitions, selectedLinters }) {
	const selectedSet = new Set(selectedLinters);
	const assignments = [];
	let sharedAssignment = null;

	for (const definition of definitions) {
		validateDefinition(definition);

		if (!selectedSet.has(definition.name)) {
			continue;
		}

		if (definition.isolated === true) {
			assignments.push({
				artifact_name: definition.name,
				linter_names: [definition.name],
				name: definition.name,
			});
			continue;
		}

		if (!sharedAssignment) {
			sharedAssignment = {
				artifact_name: "shared",
				linter_names: [],
				name: "",
			};
			assignments.push(sharedAssignment);
		}

		sharedAssignment.linter_names.push(definition.name);
		sharedAssignment.name = sharedAssignment.linter_names.join(" + ");
	}

	return assignments;
}

function readPatterns(patternPath) {
	return fs
		.readFileSync(patternPath, "utf8")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
}

function compilePatterns(patterns) {
	if (!Array.isArray(patterns)) {
		throw new Error("patterns must be an array");
	}

	return patterns.map((pattern) => {
		if (typeof pattern !== "string") {
			throw new Error("patterns must be strings");
		}

		return new RegExp(pattern, "i");
	});
}

function validateDefinition(definition) {
	validateDefinitionShape(definition);
	validateExecutionGroup(definition.execution_group);
	validateOptionalBoolean(definition.default_disabled, "default_disabled");
	validateOptionalBoolean(definition.isolated, "isolated");
	validateOptionalNonEmptyStringArray(
		definition.required_root_files,
		"required_root_files",
	);
	validateOptionalNonEmptyStringArray(
		definition.config_trigger_patterns,
		"config_trigger_patterns",
	);
}

function validateDefinitionShape(definition) {
	if (
		!definition ||
		typeof definition !== "object" ||
		typeof definition.name !== "string" ||
		!Array.isArray(definition.patterns)
	) {
		throw new Error("Each linter definition must include name and patterns");
	}
}

function validateExecutionGroup(executionGroup) {
	if (typeof executionGroup === "undefined") {
		return;
	}

	if (
		typeof executionGroup !== "string" ||
		!EXECUTION_GROUP_PATTERN.test(executionGroup)
	) {
		throw new Error(
			"execution_group must contain only letters, digits, dot, underscore, or hyphen",
		);
	}
}

function validateOptionalBoolean(value, fieldName) {
	if (typeof value === "undefined") {
		return;
	}

	if (typeof value !== "boolean") {
		throw new Error(`${fieldName} must be a boolean when present`);
	}
}

function validateOptionalNonEmptyStringArray(value, fieldName) {
	if (typeof value === "undefined") {
		return;
	}

	if (!isNonEmptyStringArray(value)) {
		throw new Error(`${fieldName} must be an array of non-empty strings`);
	}
}

function isNonEmptyStringArray(value) {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	);
}

module.exports = {
	buildLinterJobAssignments,
	compilePatterns,
	readPatterns,
	selectFiles,
	selectLinters,
	validateDefinition,
};
