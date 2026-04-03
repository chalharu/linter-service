const fs = require("node:fs");

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

function selectLinters({ candidatePaths, definitions, serviceConfig }) {
	const selectedLinters = [];

	for (const definition of definitions) {
		validateDefinition(definition);

		if (!isLinterEnabled(serviceConfig, definition.name)) {
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
}

module.exports = {
	buildLinterJobAssignments,
	compilePatterns,
	readPatterns,
	selectFiles,
	selectLinters,
	validateDefinition,
};
