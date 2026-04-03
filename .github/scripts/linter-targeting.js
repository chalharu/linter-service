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
}

module.exports = {
	compilePatterns,
	readPatterns,
	selectFiles,
	selectLinters,
	validateDefinition,
};
