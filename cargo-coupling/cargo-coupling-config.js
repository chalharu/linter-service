const DEFAULT_CARGO_COUPLING_CONFIG = Object.freeze({
	max_circular: 0,
	max_critical: 0,
	min_grade: "B",
});

const GRADE_VALUES = new Set(["S", "A", "B", "C", "D", "F"]);

function normalizeCargoCouplingConfig({
	currentConfig = {},
	label = "linters.cargo-coupling",
} = {}) {
	if (
		!currentConfig ||
		typeof currentConfig !== "object" ||
		Array.isArray(currentConfig)
	) {
		throw new Error(`${label} must be an object`);
	}

	return {
		max_circular: normalizeNonNegativeInteger(
			currentConfig.max_circular,
			`${label}.max_circular`,
			DEFAULT_CARGO_COUPLING_CONFIG.max_circular,
		),
		max_critical: normalizeNonNegativeInteger(
			currentConfig.max_critical,
			`${label}.max_critical`,
			DEFAULT_CARGO_COUPLING_CONFIG.max_critical,
		),
		min_grade: normalizeGrade(
			currentConfig.min_grade,
			`${label}.min_grade`,
			DEFAULT_CARGO_COUPLING_CONFIG.min_grade,
		),
	};
}

function normalizeGrade(value, label, fallback) {
	if (value === undefined) {
		return fallback;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}

	const normalized = value.trim().toUpperCase();
	if (!GRADE_VALUES.has(normalized)) {
		throw new Error(
			`${label} must be one of: ${Array.from(GRADE_VALUES).join(", ")}`,
		);
	}

	return normalized;
}

function normalizeNonNegativeInteger(value, label, fallback) {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}

	return value;
}

function evaluateCargoCouplingCheck({ config, jsonOutput }) {
	const resolvedConfig = normalizeCargoCouplingConfig({
		currentConfig: config,
		label: "linters.cargo-coupling",
	});
	const summary = normalizeRequiredSummary(jsonOutput);
	const grade = normalizeRequiredGrade(
		summary.health_grade,
		"cargo-coupling JSON summary.health_grade",
	);
	const score = normalizeRequiredNumber(
		summary.health_score,
		"cargo-coupling JSON summary.health_score",
	);
	const criticalCount = normalizeRequiredCount(
		summary.critical_issues,
		"cargo-coupling JSON summary.critical_issues",
	);
	const highCount = normalizeRequiredCount(
		summary.high_issues,
		"cargo-coupling JSON summary.high_issues",
	);
	const mediumCount = normalizeRequiredCount(
		summary.medium_issues,
		"cargo-coupling JSON summary.medium_issues",
	);
	normalizeRequiredCount(
		summary.total_couplings,
		"cargo-coupling JSON summary.total_couplings",
	);
	normalizeRequiredCount(
		summary.total_modules,
		"cargo-coupling JSON summary.total_modules",
	);
	const circularCount =
		normalizeRequiredCircularDependencies(jsonOutput).length;
	const failures = [];

	if (gradeRank(grade) < gradeRank(resolvedConfig.min_grade)) {
		failures.push(
			`Grade ${grade} is below minimum ${resolvedConfig.min_grade}`,
		);
	}

	if (criticalCount > resolvedConfig.max_critical) {
		failures.push(
			`${criticalCount} critical issues (max: ${resolvedConfig.max_critical})`,
		);
	}

	if (circularCount > resolvedConfig.max_circular) {
		failures.push(
			`${circularCount} circular dependencies (max: ${resolvedConfig.max_circular})`,
		);
	}

	return {
		circular_count: circularCount,
		critical_count: criticalCount,
		failures,
		grade,
		high_count: highCount,
		medium_count: mediumCount,
		passed: failures.length === 0,
		score,
	};
}

function normalizeRequiredSummary(jsonOutput) {
	if (
		!jsonOutput ||
		typeof jsonOutput !== "object" ||
		Array.isArray(jsonOutput)
	) {
		throw new Error("cargo-coupling JSON output must be an object");
	}

	if (
		!jsonOutput.summary ||
		typeof jsonOutput.summary !== "object" ||
		Array.isArray(jsonOutput.summary)
	) {
		throw new Error("cargo-coupling JSON summary must be an object");
	}

	return jsonOutput.summary;
}

function normalizeRequiredGrade(value, label) {
	if (value === undefined) {
		throw new Error(`${label} is required`);
	}

	return normalizeGrade(value, label);
}

function normalizeRequiredNumber(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}

	return value;
}

function normalizeRequiredCount(value, label) {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}

	return value;
}

function normalizeRequiredCircularDependencies(jsonOutput) {
	if (!Array.isArray(jsonOutput?.circular_dependencies)) {
		throw new Error(
			"cargo-coupling JSON circular_dependencies must be an array",
		);
	}

	return jsonOutput.circular_dependencies;
}

function gradeRank(grade) {
	switch (grade) {
		case "S":
			return 6;
		case "A":
			return 5;
		case "B":
			return 4;
		case "C":
			return 3;
		case "D":
			return 2;
		case "F":
			return 1;
		default:
			return 0;
	}
}

module.exports = {
	DEFAULT_CARGO_COUPLING_CONFIG,
	evaluateCargoCouplingCheck,
	normalizeCargoCouplingConfig,
};
