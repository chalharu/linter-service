const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const upsertPullRequestComment = require("./upsert-pr-comment.js");

test("creates a new marker comment when none exists", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upsert-pr-comment-"));
	const commentPath = path.join(tempDir, "comment.md");
	const body = "<!-- linter-service:results -->\ncreated\n";

	fs.writeFileSync(commentPath, body, "utf8");

	const createCalls = [];
	const updateCalls = [];
	const deleteCalls = [];
	const github = createGitHubClient({
		comments: [],
		createCalls,
		deleteCalls,
		updateCalls,
	});

	try {
		await upsertPullRequestComment({
			env: {
				COMMENT_FILE: commentPath,
				COMMENT_MARKER: "<!-- linter-service:results -->",
				PR_NUMBER: "38",
				PR_OWNER: "chalharu",
				PR_REPO: "copilot-sandbox-orchestrator",
			},
			github,
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}

	assert.deepEqual(updateCalls, []);
	assert.deepEqual(deleteCalls, []);
	assert.equal(createCalls.length, 1);
	assert.deepEqual(createCalls[0], {
		body,
		issue_number: 38,
		owner: "chalharu",
		repo: "copilot-sandbox-orchestrator",
	});
});

test("updates the oldest marker comment and removes duplicate marker comments", async () => {
	const createCalls = [];
	const updateCalls = [];
	const deleteCalls = [];
	const github = createGitHubClient({
		comments: [
			{
				body: "unrelated",
				created_at: "2026-04-01T06:48:35Z",
				id: 9,
			},
			{
				body: "<!-- linter-service:results -->\nsecond\n",
				created_at: "2026-04-01T06:48:36Z",
				id: 22,
			},
			{
				body: "<!-- linter-service:results -->\nfirst\n",
				created_at: "2026-04-01T06:48:36Z",
				id: 21,
			},
		],
		createCalls,
		deleteCalls,
		updateCalls,
	});

	await upsertPullRequestComment({
		env: {
			COMMENT_BODY: "<!-- linter-service:results -->\nupdated\n",
			COMMENT_MARKER: "<!-- linter-service:results -->",
			PR_NUMBER: "38",
			PR_OWNER: "chalharu",
			PR_REPO: "copilot-sandbox-orchestrator",
		},
		github,
	});

	assert.deepEqual(createCalls, []);
	assert.deepEqual(updateCalls, [
		{
			body: "<!-- linter-service:results -->\nupdated\n",
			comment_id: 21,
			owner: "chalharu",
			repo: "copilot-sandbox-orchestrator",
		},
	]);
	assert.deepEqual(deleteCalls, [
		{
			comment_id: 22,
			owner: "chalharu",
			repo: "copilot-sandbox-orchestrator",
		},
	]);
});

test("falls back to the default failure body when no comment file exists", async () => {
	const createCalls = [];
	const github = createGitHubClient({
		comments: [],
		createCalls,
		deleteCalls: [],
		updateCalls: [],
	});

	await upsertPullRequestComment({
		env: {
			COMMENT_FILE: path.join(os.tmpdir(), "missing-comment-file.md"),
			COMMENT_MARKER: "<!-- linter-service:results -->",
			PR_NUMBER: "38",
			PR_OWNER: "chalharu",
			PR_REPO: "copilot-sandbox-orchestrator",
		},
		github,
	});

	assert.equal(createCalls.length, 1);
	assert.equal(
		createCalls[0].body,
		[
			"<!-- linter-service:results -->",
			"## linter-service",
			"",
			"❌ The linter-service workflow failed to generate a combined report. See the workflow logs.",
			"",
		].join("\n"),
	);
});

function createGitHubClient({
	comments,
	createCalls,
	deleteCalls,
	updateCalls,
}) {
	return {
		paginate: async (handler, params) => {
			assert.equal(handler, issues.listComments);
			assert.deepEqual(params, {
				issue_number: 38,
				owner: "chalharu",
				per_page: 100,
				repo: "copilot-sandbox-orchestrator",
			});
			return comments;
		},
		rest: {
			issues: {
				createComment: async (params) => {
					createCalls.push(params);
				},
				deleteComment: async (params) => {
					deleteCalls.push(params);
				},
				listComments: issues.listComments,
				updateComment: async (params) => {
					updateCalls.push(params);
				},
			},
		},
	};
}

const issues = {
	listComments() {},
};
