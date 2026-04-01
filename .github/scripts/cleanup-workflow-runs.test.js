const assert = require("node:assert/strict");
const test = require("node:test");

const cleanupWorkflowRuns = require("./cleanup-workflow-runs.js");

test("deletes only completed workflow runs older than the retention window", async () => {
	const deleteCalls = [];
	const paginateCalls = [];
	const logs = [];
	const github = createGitHubClient({
		deleteCalls,
		paginateCalls,
		runs: [
			{
				id: 51,
				name: "Repository Dispatch",
				status: "completed",
				updated_at: "2026-03-31T11:59:59Z",
			},
			{
				id: 52,
				name: "CI",
				status: "completed",
				updated_at: "2026-03-31T12:00:00Z",
			},
			{
				id: 53,
				name: "CI",
				status: "completed",
				updated_at: "2026-03-31T12:00:01Z",
			},
			{
				id: 54,
				name: "Cleanup Workflow Runs",
				status: "in_progress",
				updated_at: "2026-03-31T01:00:00Z",
			},
			{
				id: 55,
				name: "Broken",
				status: "completed",
				updated_at: "not-a-timestamp",
			},
		],
	});

	const result = await cleanupWorkflowRuns({
		env: {
			NOW: "2026-04-01T12:00:00Z",
			REPOSITORY_NAME: "linter-service",
			REPOSITORY_OWNER: "chalharu",
			RETENTION_HOURS: "24",
		},
		github,
		logger: { log: (message) => logs.push(message) },
	});

	assert.deepEqual(paginateCalls, [
		{
			owner: "chalharu",
			per_page: 100,
			repo: "linter-service",
		},
	]);
	assert.deepEqual(deleteCalls, [
		{ owner: "chalharu", repo: "linter-service", run_id: 51 },
		{ owner: "chalharu", repo: "linter-service", run_id: 52 },
	]);
	assert.deepEqual(result, {
		cutoffTimestamp: "2026-03-31T12:00:00.000Z",
		deletedCount: 2,
		deletedRunIds: [51, 52],
		repository: "chalharu/linter-service",
		retentionHours: 24,
		scannedRunCount: 5,
	});
	assert.match(logs[0], /Deleting completed workflow run 51/);
	assert.match(logs[1], /Deleting completed workflow run 52/);
});

test("logs a no-op message when no old completed workflow runs exist", async () => {
	const deleteCalls = [];
	const logs = [];
	const github = createGitHubClient({
		deleteCalls,
		paginateCalls: [],
		runs: [
			{
				id: 91,
				display_title: "validate-worker",
				status: "completed",
				updated_at: "2026-04-01T11:00:00Z",
			},
		],
	});

	const result = await cleanupWorkflowRuns({
		env: {
			NOW: "2026-04-01T12:00:00Z",
			REPOSITORY_NAME: "linter-service",
			REPOSITORY_OWNER: "chalharu",
		},
		github,
		logger: { log: (message) => logs.push(message) },
	});

	assert.deepEqual(deleteCalls, []);
	assert.equal(result.deletedCount, 0);
	assert.equal(result.retentionHours, 24);
	assert.equal(
		logs[0],
		"No completed workflow runs older than 24 hour(s) were found for chalharu/linter-service.",
	);
});

test("rejects invalid retention values", async () => {
	const github = createGitHubClient({
		deleteCalls: [],
		paginateCalls: [],
		runs: [],
	});

	await assert.rejects(
		cleanupWorkflowRuns({
			env: {
				REPOSITORY_NAME: "linter-service",
				REPOSITORY_OWNER: "chalharu",
				RETENTION_HOURS: "0",
			},
			github,
		}),
		/RETENTION_HOURS must be a positive integer/,
	);
});

function createGitHubClient({ deleteCalls, paginateCalls, runs }) {
	return {
		paginate: async (handler, params) => {
			assert.equal(handler, actions.listWorkflowRunsForRepo);
			paginateCalls.push(params);
			return runs;
		},
		rest: {
			actions: {
				deleteWorkflowRun: async (params) => {
					deleteCalls.push(params);
				},
				listWorkflowRunsForRepo: actions.listWorkflowRunsForRepo,
			},
		},
	};
}

const actions = {
	listWorkflowRunsForRepo() {},
};
