module.exports = async function cleanupWorkflowRuns({
	env = process.env,
	github,
	logger = console,
}) {
	const owner = requireEnv(env, "REPOSITORY_OWNER");
	const repo = requireEnv(env, "REPOSITORY_NAME");
	const retentionHours = parsePositiveInteger(
		env.RETENTION_HOURS ?? "24",
		"RETENTION_HOURS",
	);
	const now = parseTimestamp(env.NOW ?? new Date().toISOString(), "NOW");
	const cutoffTime = now.getTime() - retentionHours * 60 * 60 * 1000;
	const runs = await github.paginate(
		github.rest.actions.listWorkflowRunsForRepo,
		{
			owner,
			per_page: 100,
			repo,
		},
	);
	const runsToDelete = collectRunsToDelete(runs, cutoffTime);

	for (const run of runsToDelete) {
		logger.log(
			`Deleting completed workflow run ${run.id} (${describeRun(run)}) updated at ${run.updated_at}`,
		);
		await github.rest.actions.deleteWorkflowRun({
			owner,
			repo,
			run_id: run.id,
		});
	}

	if (runsToDelete.length === 0) {
		logger.log(
			`No completed workflow runs older than ${retentionHours} hour(s) were found for ${owner}/${repo}.`,
		);
	}

	return {
		cutoffTimestamp: new Date(cutoffTime).toISOString(),
		deletedCount: runsToDelete.length,
		deletedRunIds: runsToDelete.map((run) => run.id),
		repository: `${owner}/${repo}`,
		retentionHours,
		scannedRunCount: Array.isArray(runs) ? runs.length : 0,
	};
};

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

function parsePositiveInteger(rawValue, key) {
	const value = Number(rawValue);

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${key} must be a positive integer`);
	}

	return value;
}

function parseTimestamp(rawValue, key) {
	const timestamp = Date.parse(rawValue);

	if (!Number.isFinite(timestamp)) {
		throw new Error(`${key} must be a valid timestamp`);
	}

	return new Date(timestamp);
}

function collectRunsToDelete(runs, cutoffTime) {
	if (!Array.isArray(runs)) {
		return [];
	}

	return runs
		.filter((run) => shouldDeleteRun(run, cutoffTime))
		.sort(compareRunsForDeletion);
}

function shouldDeleteRun(run, cutoffTime) {
	if (
		!run ||
		typeof run.id !== "number" ||
		run.id < 1 ||
		run.status !== "completed" ||
		typeof run.updated_at !== "string"
	) {
		return false;
	}

	const updatedTime = Date.parse(run.updated_at);
	return Number.isFinite(updatedTime) && updatedTime <= cutoffTime;
}

function compareRunsForDeletion(left, right) {
	const updatedDelta =
		Date.parse(left.updated_at) - Date.parse(right.updated_at);

	if (updatedDelta !== 0) {
		return updatedDelta;
	}

	return left.id - right.id;
}

function describeRun(run) {
	if (typeof run.name === "string" && run.name.length > 0) {
		return run.name;
	}

	if (typeof run.display_title === "string" && run.display_title.length > 0) {
		return run.display_title;
	}

	return "unnamed workflow";
}

module.exports.collectRunsToDelete = collectRunsToDelete;
