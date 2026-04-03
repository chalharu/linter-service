const fs = require("node:fs");
const path = require("node:path");

const {
	filterExcludedPaths,
	isLinterEnabled,
	normalizeRelativePath,
} = require("./linter-service-config.js");

function selectFiles({ candidatePaths, linterName, patterns, serviceConfig }) {
	const compiledPatterns = compilePatterns(patterns);
	const normalizedCandidates = candidatePaths.map(normalizeRelativePath);
	const filteredCandidates = filterExcludedPaths(
		serviceConfig,
		linterName,
		normalizedCandidates,
	);

	return filteredCandidates.filter((candidatePath) =>
		compiledPatterns.some((pattern) => pattern.test(candidatePath)),
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

		if (
			selectFiles({
				candidatePaths,
				linterName: definition.name,
				patterns: definition.patterns,
				serviceConfig,
			}).length > 0
		) {
			selectedLinters.push(definition.name);
		}
	}

	return selectedLinters;
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
	const groupedAssignments = new Map();
	const assignments = [];

	for (const definition of definitions) {
		validateDefinition(definition);

		if (!selectedSet.has(definition.name)) {
			continue;
		}

		if (typeof definition.execution_group === "string") {
			const artifactName = `group-${definition.execution_group}`;
			let assignment = groupedAssignments.get(definition.execution_group);

			if (!assignment) {
				assignment = {
					artifact_name: artifactName,
					linter_names: [],
					name: "",
				};
				groupedAssignments.set(definition.execution_group, assignment);
				assignments.push(assignment);
			}

			assignment.linter_names.push(definition.name);
			assignment.name = assignment.linter_names.join(" + ");
			continue;
		}

		assignments.push({
			artifact_name: definition.name,
			linter_names: [definition.name],
			name: definition.name,
		});
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
		typeof definition.required_root_files !== "undefined" &&
		(!Array.isArray(definition.required_root_files) ||
			definition.required_root_files.some(
				(filePath) =>
					typeof filePath !== "string" || filePath.trim().length === 0,
			))
	) {
		throw new Error(
			"required_root_files must be an array of non-empty strings",
		);
	}
}

module.exports = {
	buildLinterJobAssignments,
	compilePatterns,
	readPatterns,
	selectFiles,
	selectLinters,
	validateDefinition,
};
