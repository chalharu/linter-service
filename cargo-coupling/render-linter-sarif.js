function buildSarifResults({
	createResult,
	dedupeResults,
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	result,
	sourceRepositoryPath,
	targetPaths,
}) {
	if (linterName !== "cargo-coupling") {
		return [];
	}

	const runs = Array.isArray(result?.cargo_coupling_runs)
		? result.cargo_coupling_runs
		: [];

	return dedupeResults(
		runs.flatMap((run) =>
			buildRunResults({
				createResult,
				linterName,
				normalizeReportedPath,
				reportedPathRoots,
				run,
				sourceRepositoryPath,
				targetPaths,
			}),
		),
	);
}

function buildRunResults({
	createResult,
	linterName,
	normalizeReportedPath,
	reportedPathRoots,
	run,
	sourceRepositoryPath,
	targetPaths,
}) {
	const modulePaths = buildModulePathMap({
		jsonOutput: run?.json_output,
		normalizeReportedPath,
		reportedPathRoots,
		sourceRepositoryPath,
		targetPaths,
	});

	return [
		...buildIssueResults({ createResult, linterName, modulePaths, run }),
		...buildCircularDependencyResults({ createResult, linterName, modulePaths, run }),
	];
}

function buildIssueResults({ createResult, linterName, modulePaths, run }) {
	const issues = Array.isArray(run?.json_output?.issues)
		? run.json_output.issues
		: [];

	return issues.map((issue) => {
		const source = String(issue?.source || "").trim();
		const target = String(issue?.target || "").trim();
		const filePath = modulePaths.get(source) || modulePaths.get(target) || null;
		return createResult({
			column: filePath ? 1 : null,
			filePath,
			level: mapIssueLevel(issue?.severity),
			line: filePath ? 1 : null,
			linterName,
			message: buildIssueMessage(issue),
			ruleId: slugifyIssueType(issue?.issue_type),
		});
	});
}

function buildCircularDependencyResults({
	createResult,
	linterName,
	modulePaths,
	run,
}) {
	const circularDependencies = Array.isArray(run?.json_output?.circular_dependencies)
		? run.json_output.circular_dependencies
		: [];

	return circularDependencies.map((cycle) => {
		const firstModule = Array.isArray(cycle) ? cycle[0] : null;
		const filePath =
			typeof firstModule === "string" ? modulePaths.get(firstModule) || null : null;
		return createResult({
			column: filePath ? 1 : null,
			filePath,
			level: "error",
			line: filePath ? 1 : null,
			linterName,
			message: `Circular dependency: ${cycle.map((entry) => String(entry)).join(" -> ")}`,
			ruleId: "cargo-coupling/circular-dependency",
		});
	});
}

function buildModulePathMap({
	jsonOutput,
	normalizeReportedPath,
	reportedPathRoots,
	sourceRepositoryPath,
	targetPaths,
}) {
	const modules = Array.isArray(jsonOutput?.modules) ? jsonOutput.modules : [];
	return new Map(
		modules
			.map((module) => {
				if (
					!module ||
					typeof module.name !== "string" ||
					typeof module.file_path !== "string"
				) {
					return null;
				}

				const filePath = normalizeReportedPath(
					sourceRepositoryPath,
					module.file_path,
					targetPaths,
					reportedPathRoots,
				);
				return filePath ? [module.name, filePath] : null;
			})
			.filter(Boolean),
	);
}

function buildIssueMessage(issue) {
	const source = String(issue?.source || "").trim();
	const target = String(issue?.target || "").trim();
	const description =
		typeof issue?.description === "string" &&
		issue.description.trim().length > 0
			? issue.description.trim()
			: "cargo-coupling reported an issue";
	const suggestion =
		typeof issue?.suggestion === "string" && issue.suggestion.trim().length > 0
			? ` Suggestion: ${issue.suggestion.trim()}`
			: "";
	const subject = [source, target].filter(Boolean).join(" -> ");
	return `${subject.length > 0 ? `${subject}: ` : ""}${description}${suggestion}`;
}

function buildSarifRules({ result }) {
	const runs = Array.isArray(result?.cargo_coupling_runs)
		? result.cargo_coupling_runs
		: [];
	const rules = new Map();

	for (const run of runs) {
		for (const issue of Array.isArray(run?.json_output?.issues)
			? run.json_output.issues
			: []) {
			const id = slugifyIssueType(issue?.issue_type);
			if (!rules.has(id)) {
				rules.set(id, {
					id,
					name:
						typeof issue?.issue_type === "string" &&
						issue.issue_type.trim().length > 0
							? issue.issue_type.trim()
							: id,
					shortDescription: {
						text:
							typeof issue?.issue_type === "string" &&
							issue.issue_type.trim().length > 0
								? issue.issue_type.trim()
								: id,
					},
				});
			}
		}

		if (
			Array.isArray(run?.json_output?.circular_dependencies) &&
			run.json_output.circular_dependencies.length > 0
		) {
			rules.set("cargo-coupling/circular-dependency", {
				id: "cargo-coupling/circular-dependency",
				name: "Circular Dependency",
				shortDescription: {
					text: "Circular Dependency",
				},
			});
		}
	}

	return [...rules.values()];
}

function mapIssueLevel(severity) {
	switch (
		String(severity || "")
			.trim()
			.toLowerCase()
	) {
		case "critical":
			return "error";
		case "high":
		case "medium":
			return "warning";
		case "low":
			return "note";
		default:
			return "warning";
	}
}

function slugifyIssueType(value) {
	return `cargo-coupling/${
		String(value || "diagnostic")
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "diagnostic"
	}`;
}

module.exports = {
	buildSarifResults,
	buildSarifRules,
};
