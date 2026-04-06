const fs = require("node:fs");
const path = require("node:path");

const {
	filterExcludedPaths,
	getTextlintPresetPackages,
	isLinterEnabled,
	normalizeRelativePath,
} = require("./linter-service-config.js");

function selectFiles({
	candidatePaths,
	linterName,
	patterns,
	repositoryPath,
	serviceConfig,
}) {
	const compiledPatterns = compilePatterns(patterns);
	const normalizedCandidates = candidatePaths.map(normalizeRelativePath);
	const filteredCandidates = filterExcludedPaths(
		serviceConfig,
		linterName,
		normalizedCandidates,
	);

	return filterMatchedFiles({
		linterName,
		repositoryPath,
		selectedFiles: filteredCandidates.filter((candidatePath) =>
			compiledPatterns.some((pattern) => pattern.test(candidatePath)),
		),
	});
}

function hasPatternMatch({
	candidatePaths,
	linterName,
	patterns,
	repositoryPath,
	serviceConfig,
}) {
	if (!Array.isArray(patterns) || patterns.length === 0) {
		return false;
	}

	return (
		selectFiles({
			candidatePaths,
			linterName,
			patterns,
			repositoryPath,
			serviceConfig,
		}).length > 0
	);
}

function selectLinters({
	candidatePaths,
	definitions,
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

		if (!hasRequiredRuntimeConfig(definition, serviceConfig)) {
			continue;
		}

		if (
			hasPatternMatch({
				candidatePaths,
				linterName: definition.name,
				patterns: definition.patterns,
				repositoryPath,
				serviceConfig,
			}) ||
			hasPatternMatch({
				candidatePaths,
				linterName: definition.name,
				patterns: definition.config_trigger_patterns,
				repositoryPath,
				serviceConfig,
			})
		) {
			selectedLinters.push(definition.name);
		}
	}

	return selectedLinters;
}

function filterMatchedFiles({ linterName, repositoryPath, selectedFiles }) {
	if (linterName !== "helmlint") {
		return selectedFiles;
	}

	if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
		return selectedFiles;
	}

	return selectedFiles.filter(
		(candidatePath) =>
			findHelmChartRoot({
				filePath: candidatePath,
				repositoryPath,
			}) !== null,
	);
}

function findHelmChartRoot({ filePath, repositoryPath }) {
	if (
		typeof filePath !== "string" ||
		filePath.trim().length === 0 ||
		typeof repositoryPath !== "string" ||
		repositoryPath.length === 0
	) {
		return null;
	}

	const resolvedRepositoryPath = path.resolve(repositoryPath);
	let currentDir = path.dirname(normalizeRelativePath(filePath));

	if (currentDir.length === 0) {
		currentDir = ".";
	}

	while (true) {
		const candidatePath =
			currentDir === "." ? "Chart.yaml" : path.join(currentDir, "Chart.yaml");
		const resolvedCandidatePath = path.resolve(
			resolvedRepositoryPath,
			candidatePath,
		);
		const relativeCandidatePath = path.relative(
			resolvedRepositoryPath,
			resolvedCandidatePath,
		);

		if (
			relativeCandidatePath !== ".." &&
			!relativeCandidatePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativeCandidatePath) &&
			fs.existsSync(resolvedCandidatePath)
		) {
			return currentDir === "." ? "." : normalizeRelativePath(currentDir);
		}

		if (currentDir === "." || currentDir === "/" || currentDir === "") {
			return null;
		}

		const nextDir = path.dirname(currentDir);
		if (nextDir === currentDir) {
			return null;
		}

		currentDir = nextDir;
	}
}

function hasRequiredRuntimeConfig(definition, serviceConfig) {
	if (definition.name !== "textlint") {
		return true;
	}

	return getTextlintPresetPackages(serviceConfig).length > 0;
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
	if (
		!definition ||
		typeof definition !== "object" ||
		typeof definition.name !== "string" ||
		!Array.isArray(definition.patterns)
	) {
		throw new Error("Each linter definition must include name and patterns");
	}

	if (
		typeof definition.execution_group !== "undefined" &&
		(typeof definition.execution_group !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(definition.execution_group))
	) {
		throw new Error(
			"execution_group must contain only letters, digits, dot, underscore, or hyphen",
		);
	}

	if (
		typeof definition.default_disabled !== "undefined" &&
		typeof definition.default_disabled !== "boolean"
	) {
		throw new Error("default_disabled must be a boolean when present");
	}

	if (
		typeof definition.isolated !== "undefined" &&
		typeof definition.isolated !== "boolean"
	) {
		throw new Error("isolated must be a boolean when present");
	}

	if (
		typeof definition.required_root_files !== "undefined" &&
		!isNonEmptyStringArray(definition.required_root_files)
	) {
		throw new Error(
			"required_root_files must be an array of non-empty strings",
		);
	}

	if (
		typeof definition.config_trigger_patterns !== "undefined" &&
		!isNonEmptyStringArray(definition.config_trigger_patterns)
	) {
		throw new Error(
			"config_trigger_patterns must be an array of non-empty strings",
		);
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
