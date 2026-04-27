const { buildSarifEnvelope } = require("./sarif.js");

function parsePositiveInteger(value) {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? value : null;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePath(filePath) {
	return String(filePath || "")
		.replace(/\\/gu, "/")
		.replace(/^\.\//u, "")
		.trim();
}

function normalizeLevel(level) {
	switch (
		String(level || "")
			.trim()
			.toLowerCase()
	) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
		case "note":
		case "style":
			return "note";
		default:
			return "warning";
	}
}

function normalizeDiagnostic(diagnostic, { defaultRuleId }) {
	if (!diagnostic || typeof diagnostic !== "object") {
		return null;
	}

	const message =
		typeof diagnostic.message === "string" ? diagnostic.message.trim() : "";
	if (message.length === 0) {
		return null;
	}

	const filePath =
		typeof diagnostic.file_path === "string" &&
		diagnostic.file_path.trim().length > 0
			? normalizePath(diagnostic.file_path)
			: null;
	const ruleId =
		typeof diagnostic.rule_id === "string" &&
		diagnostic.rule_id.trim().length > 0
			? diagnostic.rule_id.trim()
			: defaultRuleId;
	const helpUri =
		typeof diagnostic.help_uri === "string" &&
		diagnostic.help_uri.trim().length > 0
			? diagnostic.help_uri.trim()
			: null;

	return {
		column: parsePositiveInteger(diagnostic.column),
		endColumn: parsePositiveInteger(diagnostic.end_column),
		endLine: parsePositiveInteger(diagnostic.end_line),
		filePath,
		helpUri,
		level: normalizeLevel(diagnostic.level),
		line: parsePositiveInteger(diagnostic.line),
		message,
		ruleId,
	};
}

function buildDiagnosticKey(diagnostic) {
	return [
		diagnostic.filePath || "",
		String(diagnostic.line || 0),
		String(diagnostic.column || 0),
		String(diagnostic.endLine || 0),
		String(diagnostic.endColumn || 0),
		diagnostic.level,
		diagnostic.ruleId,
		diagnostic.message,
	].join("\u0000");
}

function sortDiagnostics(left, right) {
	return [
		left.filePath || "",
		String(left.line || 0),
		String(left.column || 0),
		left.ruleId,
		left.message,
		left.level,
	]
		.join("\u0000")
		.localeCompare(
			[
				right.filePath || "",
				String(right.line || 0),
				String(right.column || 0),
				right.ruleId,
				right.message,
				right.level,
			].join("\u0000"),
		);
}

function dedupeDiagnostics(diagnostics) {
	const seen = new Set();

	return diagnostics.filter((diagnostic) => {
		const key = buildDiagnosticKey(diagnostic);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function buildRegion(diagnostic) {
	const region = {};

	if (diagnostic.line !== null) {
		region.startLine = diagnostic.line;
	}
	if (diagnostic.column !== null) {
		region.startColumn = diagnostic.column;
	}
	if (diagnostic.endLine !== null) {
		region.endLine = diagnostic.endLine;
	}
	if (diagnostic.endColumn !== null) {
		region.endColumn = diagnostic.endColumn;
	}

	return Object.keys(region).length > 0 ? region : null;
}

function buildSarifResult(diagnostic, linterName) {
	const region = buildRegion(diagnostic);
	const result = {
		level: diagnostic.level,
		message: {
			text: diagnostic.message,
		},
		properties: {
			linter_name: linterName,
		},
		ruleId: diagnostic.ruleId,
	};

	if (diagnostic.filePath) {
		result.locations = [
			{
				physicalLocation: {
					artifactLocation: {
						uri: diagnostic.filePath,
					},
					...(region ? { region } : {}),
				},
			},
		];
	}

	return result;
}

function buildSarifRules(diagnostics) {
	const rulesById = new Map();

	for (const diagnostic of diagnostics) {
		if (rulesById.has(diagnostic.ruleId)) {
			continue;
		}

		rulesById.set(diagnostic.ruleId, {
			id: diagnostic.ruleId,
			name: diagnostic.ruleId,
			...(diagnostic.helpUri ? { helpUri: diagnostic.helpUri } : {}),
			shortDescription: {
				text: diagnostic.ruleId,
			},
		});
	}

	return [...rulesById.values()];
}

function buildSarifFromDiagnostics({ defaultRuleId, diagnostics, linterName }) {
	const normalizedDiagnostics = dedupeDiagnostics(
		(Array.isArray(diagnostics) ? diagnostics : [])
			.map((diagnostic) => normalizeDiagnostic(diagnostic, { defaultRuleId }))
			.filter((diagnostic) => diagnostic !== null)
			.sort(sortDiagnostics),
	);

	return buildSarifEnvelope({
		category: `linter-service/${linterName}`,
		results: normalizedDiagnostics.map((diagnostic) =>
			buildSarifResult(diagnostic, linterName),
		),
		rules: buildSarifRules(normalizedDiagnostics),
		toolName: `linter-service/${linterName}`,
	});
}

module.exports = {
	buildSarifFromDiagnostics,
	dedupeDiagnostics,
	normalizeDiagnostic,
	normalizeLevel,
	parsePositiveInteger,
};
