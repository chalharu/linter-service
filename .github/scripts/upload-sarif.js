const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const requireEnv = require("./lib/require-env.js");

const DEFAULT_POLL_ATTEMPTS = 15;
const DEFAULT_POLL_INTERVAL_MS = 2000;

module.exports = async function uploadSarif({ github, env }) {
	const rootPath = requireEnv(env, "SARIF_ROOT");

	if (!fs.existsSync(rootPath)) {
		return { skipped: 0, uploaded: 0 };
	}

	const owner = requireEnv(env, "SARIF_OWNER");
	const repo = requireEnv(env, "SARIF_REPO");
	const commitSha = requireEnv(env, "SARIF_HEAD_SHA");
	const ref = resolveSarifRef(env);
	const pollAttempts = readPositiveIntegerEnv(
		env,
		"SARIF_POLL_ATTEMPTS",
		DEFAULT_POLL_ATTEMPTS,
	);
	const pollIntervalMs = readPositiveIntegerEnv(
		env,
		"SARIF_POLL_INTERVAL_MS",
		DEFAULT_POLL_INTERVAL_MS,
	);
	const files = fs
		.readdirSync(rootPath)
		.filter((fileName) => fileName.endsWith(".sarif"))
		.sort();
	const pendingUploads = [];
	let skipped = 0;
	let uploaded = 0;

	for (const fileName of files) {
		const sarifPath = path.join(rootPath, fileName);
		const sarifText = fs.readFileSync(sarifPath, "utf8");

		try {
			const response = await github.request(
				"POST /repos/{owner}/{repo}/code-scanning/sarifs",
				{
					commit_sha: commitSha,
					owner,
					ref,
					repo,
					sarif: gzipAndEncodeSarif(sarifText),
				},
			);
			const uploadId = extractSarifUploadId(response);

			if (uploadId === null) {
				throw new Error(
					`GitHub did not return a SARIF upload id for ${fileName}`,
				);
			}

			if (response?.data?.processing_status === "complete") {
				uploaded += 1;
				continue;
			}

			pendingUploads.push({
				fileName,
				uploadId,
			});
		} catch (error) {
			if (isSkippableSarifUploadError(error)) {
				console.warn(
					`Skipping SARIF upload for ${owner}/${repo}: ${extractErrorMessage(error)}`,
				);
				skipped += 1;
				continue;
			}

			throw error;
		}
	}

	if (pendingUploads.length > 0) {
		uploaded += await waitForPendingUploads({
			github,
			owner,
			pollAttempts,
			pollIntervalMs,
			pendingUploads,
			repo,
		});
	}

	return { skipped, uploaded };
};

function readPositiveIntegerEnv(env, key, fallbackValue) {
	const raw = env[key];

	if (raw === undefined || raw === null || raw === "") {
		return fallbackValue;
	}

	if (!/^[1-9]\d*$/u.test(String(raw))) {
		throw new Error(`${key} must be a positive integer`);
	}

	return Number(raw);
}

function resolveSarifRef(env) {
	const prNumber = env.SARIF_PR_NUMBER;

	if (typeof prNumber === "string" && prNumber.length > 0) {
		if (!/^[1-9]\d*$/u.test(prNumber)) {
			throw new Error("SARIF_PR_NUMBER must be a positive integer");
		}

		return `refs/pull/${prNumber}/head`;
	}

	return normalizeRef(requireEnv(env, "SARIF_REF"));
}

function normalizeRef(value) {
	return value.startsWith("refs/") ? value : `refs/heads/${value}`;
}

function extractSarifUploadId(response) {
	const id = response?.data?.id ?? response?.data?.sarif_id;

	if (typeof id === "number" && Number.isFinite(id)) {
		return String(id);
	}

	return typeof id === "string" && id.length > 0 ? id : null;
}

async function waitForPendingUploads({
	github,
	owner,
	pendingUploads,
	pollAttempts,
	pollIntervalMs,
	repo,
}) {
	const pendingById = new Map(
		pendingUploads.map((upload) => [upload.uploadId, upload.fileName]),
	);
	let completed = 0;

	for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
		for (const [uploadId, fileName] of pendingById.entries()) {
			const response = await github.request(
				"GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}",
				{
					owner,
					repo,
					sarif_id: uploadId,
				},
			);
			const status = String(response?.data?.processing_status || "");

			if (status === "complete") {
				pendingById.delete(uploadId);
				completed += 1;
				continue;
			}

			if (status === "failed") {
				throw new Error(
					buildProcessingFailureMessage(fileName, uploadId, response),
				);
			}
		}

		if (pendingById.size === 0) {
			return completed;
		}

		if (attempt < pollAttempts) {
			await delay(pollIntervalMs);
		}
	}

	const pendingFiles = [...pendingById.values()].join(", ");
	throw new Error(
		`Timed out waiting for GitHub to finish processing SARIF upload(s): ${pendingFiles}`,
	);
}

function buildProcessingFailureMessage(fileName, uploadId, response) {
	const errors = Array.isArray(response?.data?.errors)
		? response.data.errors
		: [];
	const details = errors
		.map((error) => {
			if (typeof error === "string") {
				return error;
			}

			if (typeof error?.message === "string") {
				return error.message;
			}

			if (typeof error?.description === "string") {
				return error.description;
			}

			return "";
		})
		.filter(Boolean)
		.join("; ");

	if (details.length > 0) {
		return `GitHub failed to process ${fileName} (upload ${uploadId}): ${details}`;
	}

	return `GitHub failed to process ${fileName} (upload ${uploadId})`;
}

function delay(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function gzipAndEncodeSarif(sarifText) {
	return zlib.gzipSync(Buffer.from(sarifText, "utf8")).toString("base64");
}

function isUnsupportedCodeScanningError(error) {
	const message = extractErrorMessage(error);

	return (
		(error?.status === 403 || error?.status === 422) &&
		/GitHub Code Security|GitHub Advanced Security|code scanning.*enabled/iu.test(
			message,
		)
	);
}

function isMissingRefError(error) {
	const message = extractErrorMessage(error);

	return (
		error?.status === 422 &&
		/ref ['"`]?(?:refs\/heads\/)?[^'"`]+['"`]? not found in this repository/iu.test(
			message,
		)
	);
}

function isSkippableSarifUploadError(error) {
	return isUnsupportedCodeScanningError(error) || isMissingRefError(error);
}

function extractErrorMessage(error) {
	if (typeof error?.response?.data?.message === "string") {
		return error.response.data.message;
	}

	if (typeof error?.message === "string") {
		return error.message;
	}

	return "Unknown code scanning upload error";
}

module.exports.gzipAndEncodeSarif = gzipAndEncodeSarif;
module.exports.isMissingRefError = isMissingRefError;
module.exports.isSkippableSarifUploadError = isSkippableSarifUploadError;
module.exports.isUnsupportedCodeScanningError = isUnsupportedCodeScanningError;
module.exports.normalizeRef = normalizeRef;
module.exports.resolveSarifRef = resolveSarifRef;
