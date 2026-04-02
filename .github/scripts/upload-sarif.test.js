const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
	cleanupTempRepo,
	makeTempRepo,
	writeFile,
} = require("./linters/cargo-linter-test-lib.js");
const uploadSarif = require("./upload-sarif.js");

test("uploads each SARIF file, uses the PR ref, and waits for completion", async () => {
	const context = makeTempRepo("upload-sarif-success-");
	const sarifRoot = path.join(context.tempDir, "sarif");
	const calls = [];

	fs.mkdirSync(sarifRoot, { recursive: true });
	writeFile(
		path.join(sarifRoot, "example.sarif"),
		JSON.stringify({
			version: "2.1.0",
			runs: [
				{
					automationDetails: { id: "linter-service/example" },
					results: [],
					tool: { driver: { name: "linter-service/example" } },
				},
			],
		}),
	);

	try {
		const outcome = await uploadSarif({
			env: {
				SARIF_HEAD_SHA: "abc123",
				SARIF_OWNER: "octo",
				SARIF_POLL_ATTEMPTS: "2",
				SARIF_POLL_INTERVAL_MS: "1",
				SARIF_PR_NUMBER: "42",
				SARIF_REPO: "demo",
				SARIF_ROOT: sarifRoot,
			},
			github: {
				request: async (route, params) => {
					calls.push({ params, route });

					if (route === "POST /repos/{owner}/{repo}/code-scanning/sarifs") {
						return { data: { id: "1", processing_status: "pending" } };
					}

					return { data: { processing_status: "complete" } };
				},
			},
		});

		assert.deepEqual(outcome, { skipped: 0, uploaded: 1 });
		assert.equal(calls.length, 2);
		assert.equal(
			calls[0].route,
			"POST /repos/{owner}/{repo}/code-scanning/sarifs",
		);
		assert.equal(
			calls[1].route,
			"GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}",
		);
		assert.equal(calls[0].params.owner, "octo");
		assert.equal(calls[0].params.repo, "demo");
		assert.equal(calls[0].params.commit_sha, "abc123");
		assert.equal(calls[0].params.ref, "refs/pull/42/head");
		assert.equal(calls[1].params.sarif_id, "1");

		const decoded = zlib
			.gunzipSync(Buffer.from(calls[0].params.sarif, "base64"))
			.toString("utf8");
		assert.match(decoded, /"version":"2\.1\.0"/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("returns success when there are no SARIF files to upload", async () => {
	const context = makeTempRepo("upload-sarif-empty-");
	const sarifRoot = path.join(context.tempDir, "sarif");

	fs.mkdirSync(sarifRoot, { recursive: true });

	try {
		const outcome = await uploadSarif({
			env: {
				SARIF_HEAD_SHA: "abc123",
				SARIF_OWNER: "octo",
				SARIF_REF: "feature/test",
				SARIF_REPO: "demo",
				SARIF_ROOT: sarifRoot,
			},
			github: {
				request: async () => {
					throw new Error("request should not be called");
				},
			},
		});

		assert.deepEqual(outcome, { skipped: 0, uploaded: 0 });
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("soft-skips repositories where code scanning is unavailable", async () => {
	const context = makeTempRepo("upload-sarif-skip-");
	const sarifRoot = path.join(context.tempDir, "sarif");

	fs.mkdirSync(sarifRoot, { recursive: true });
	writeFile(
		path.join(sarifRoot, "example.sarif"),
		'{"version":"2.1.0","runs":[]}',
	);

	try {
		const outcome = await uploadSarif({
			env: {
				SARIF_HEAD_SHA: "abc123",
				SARIF_OWNER: "octo",
				SARIF_REF: "feature/test",
				SARIF_REPO: "demo",
				SARIF_ROOT: sarifRoot,
			},
			github: {
				request: async () => {
					const error = new Error(
						"GitHub Code Security or GitHub Advanced Security must be enabled for this repository to use code scanning",
					);
					error.status = 403;
					error.response = { data: { message: error.message } };
					throw error;
				},
			},
		});

		assert.deepEqual(outcome, { skipped: 1, uploaded: 0 });
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("fails when GitHub reports SARIF processing errors", async () => {
	const context = makeTempRepo("upload-sarif-processing-failed-");
	const sarifRoot = path.join(context.tempDir, "sarif");

	fs.mkdirSync(sarifRoot, { recursive: true });
	writeFile(
		path.join(sarifRoot, "example.sarif"),
		'{"version":"2.1.0","runs":[]}',
	);

	try {
		await assert.rejects(
			() =>
				uploadSarif({
					env: {
						SARIF_HEAD_SHA: "abc123",
						SARIF_OWNER: "octo",
						SARIF_POLL_ATTEMPTS: "1",
						SARIF_POLL_INTERVAL_MS: "1",
						SARIF_PR_NUMBER: "42",
						SARIF_REPO: "demo",
						SARIF_ROOT: sarifRoot,
					},
					github: {
						request: async (route) => {
							if (route === "POST /repos/{owner}/{repo}/code-scanning/sarifs") {
								return { data: { id: "1", processing_status: "pending" } };
							}

							return {
								data: {
									errors: [{ message: "invalid SARIF" }],
									processing_status: "failed",
								},
							};
						},
					},
				}),
			/invalid SARIF/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("rethrows unexpected upload errors", async () => {
	const context = makeTempRepo("upload-sarif-error-");
	const sarifRoot = path.join(context.tempDir, "sarif");

	fs.mkdirSync(sarifRoot, { recursive: true });
	writeFile(
		path.join(sarifRoot, "example.sarif"),
		'{"version":"2.1.0","runs":[]}',
	);

	try {
		await assert.rejects(() =>
			uploadSarif({
				env: {
					SARIF_HEAD_SHA: "abc123",
					SARIF_OWNER: "octo",
					SARIF_REF: "feature/test",
					SARIF_REPO: "demo",
					SARIF_ROOT: sarifRoot,
				},
				github: {
					request: async () => {
						const error = new Error("Resource not accessible by integration");
						error.status = 403;
						error.response = { data: { message: error.message } };
						throw error;
					},
				},
			}),
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
