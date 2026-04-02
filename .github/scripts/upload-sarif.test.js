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

test("uploads each SARIF file with gzip+base64 payload", async () => {
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
				SARIF_REF: "feature/test",
				SARIF_REPO: "demo",
				SARIF_ROOT: sarifRoot,
			},
			github: {
				request: async (route, params) => {
					calls.push({ params, route });
					return { data: { id: "1" } };
				},
			},
		});

		assert.deepEqual(outcome, { skipped: 0, uploaded: 1 });
		assert.equal(calls.length, 1);
		assert.equal(
			calls[0].route,
			"POST /repos/{owner}/{repo}/code-scanning/sarifs",
		);
		assert.equal(calls[0].params.owner, "octo");
		assert.equal(calls[0].params.repo, "demo");
		assert.equal(calls[0].params.commit_sha, "abc123");
		assert.equal(calls[0].params.ref, "refs/heads/feature/test");

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
