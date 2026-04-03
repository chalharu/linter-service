const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const upsertCheckRun = require("./upsert-check-run.js");

test("creates a new check run with detailed output text loaded from a file", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upsert-check-run-"));
	const outputTextPath = path.join(tempDir, "check-run.md");
	const createCalls = [];

	fs.writeFileSync(
		outputTextPath,
		"## linter-service\n\nDetailed check-run output.\n",
		"utf8",
	);

	try {
		await upsertCheckRun({
			env: {
				CHECK_RUN_DETAILS_URL: "https://example.com/checks/42",
				CHECK_RUN_EXTERNAL_ID: "linter-service:42:abc123",
				CHECK_RUN_HEAD_SHA: "abc123",
				CHECK_RUN_NAME: "linter-service",
				CHECK_RUN_OUTPUT_SUMMARY:
					"1 of 2 selected linter(s) reported issues or failed.",
				CHECK_RUN_OUTPUT_TEXT_FILE: outputTextPath,
				CHECK_RUN_OUTPUT_TITLE: "linter-service found issues",
				CHECK_RUN_OWNER: "chalharu",
				CHECK_RUN_REPO: "linter-service",
				CHECK_RUN_STATUS: "completed",
				CHECK_RUN_CONCLUSION: "failure",
			},
			github: createGitHubClient({
				checkRuns: [],
				createCalls,
				updateCalls: [],
			}),
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}

	assert.equal(createCalls.length, 1);
	assert.deepEqual(createCalls[0], {
		completed_at: "2026-04-03T04:00:00.000Z",
		conclusion: "failure",
		details_url: "https://example.com/checks/42",
		external_id: "linter-service:42:abc123",
		head_sha: "abc123",
		name: "linter-service",
		owner: "chalharu",
		output: {
			summary: "1 of 2 selected linter(s) reported issues or failed.",
			text: "## linter-service\n\nDetailed check-run output.\n",
			title: "linter-service found issues",
		},
		repo: "linter-service",
		started_at: "2026-04-03T04:00:00.000Z",
		status: "completed",
	});
});

test("updates an existing check run and truncates oversized output text", async () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "upsert-check-run-update-"),
	);
	const outputTextPath = path.join(tempDir, "check-run.md");
	const updateCalls = [];

	fs.writeFileSync(outputTextPath, "x".repeat(61000), "utf8");

	try {
		await upsertCheckRun({
			env: {
				CHECK_RUN_DETAILS_URL: "https://example.com/checks/42",
				CHECK_RUN_EXTERNAL_ID: "linter-service:42:def456",
				CHECK_RUN_HEAD_SHA: "def456",
				CHECK_RUN_NAME: "linter-service",
				CHECK_RUN_OUTPUT_SUMMARY:
					"All 2 selected linter(s) completed successfully.",
				CHECK_RUN_OUTPUT_TEXT_FILE: outputTextPath,
				CHECK_RUN_OUTPUT_TITLE: "linter-service completed",
				CHECK_RUN_OWNER: "chalharu",
				CHECK_RUN_REPO: "linter-service",
				CHECK_RUN_STATUS: "completed",
				CHECK_RUN_CONCLUSION: "success",
			},
			github: createGitHubClient({
				checkRuns: [{ external_id: "linter-service:42:def456", id: 73 }],
				createCalls: [],
				updateCalls,
			}),
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}

	assert.equal(updateCalls.length, 1);
	assert.equal(updateCalls[0].check_run_id, 73);
	assert.equal(
		updateCalls[0].output.summary,
		"All 2 selected linter(s) completed successfully.",
	);
	assert.ok(updateCalls[0].output.text.endsWith("\n... truncated ..."));
	assert.equal(updateCalls[0].output.text.length, 60000);
});

test("omits output.text when no detailed output is configured", async () => {
	const createCalls = [];

	await upsertCheckRun({
		env: {
			CHECK_RUN_DETAILS_URL: "https://example.com/checks/42",
			CHECK_RUN_EXTERNAL_ID: "linter-service:42:ghi789",
			CHECK_RUN_HEAD_SHA: "ghi789",
			CHECK_RUN_NAME: "linter-service",
			CHECK_RUN_OUTPUT_SUMMARY:
				"The linter-service workflow request is being queued and should start shortly.",
			CHECK_RUN_OUTPUT_TITLE: "linter-service is queued",
			CHECK_RUN_OWNER: "chalharu",
			CHECK_RUN_REPO: "linter-service",
			CHECK_RUN_STATUS: "queued",
		},
		github: createGitHubClient({
			checkRuns: [],
			createCalls,
			updateCalls: [],
		}),
	});

	assert.equal(createCalls.length, 1);
	assert.deepEqual(createCalls[0].output, {
		summary:
			"The linter-service workflow request is being queued and should start shortly.",
		title: "linter-service is queued",
	});
});

function createGitHubClient({ checkRuns, createCalls, updateCalls }) {
	return {
		paginate: async (handler, params, mapper) => {
			assert.equal(handler, checks.listForRef);
			assert.deepEqual(params, {
				owner: "chalharu",
				per_page: 100,
				ref: params.ref,
				repo: "linter-service",
			});
			return mapper({ data: { check_runs: checkRuns } });
		},
		rest: {
			checks: {
				create: async (params) => {
					createCalls.push(params);
				},
				listForRef: checks.listForRef,
				update: async (params) => {
					updateCalls.push(params);
				},
			},
		},
	};
}

const checks = {
	listForRef() {},
};

const RealDate = Date;

test.after(() => {
	global.Date = RealDate;
});

test.beforeEach(() => {
	global.Date = class extends RealDate {
		constructor(...args) {
			if (args.length === 0) {
				super("2026-04-03T04:00:00.000Z");
				return;
			}

			super(...args);
		}

		static now() {
			return new RealDate("2026-04-03T04:00:00.000Z").valueOf();
		}
	};
});
