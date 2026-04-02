const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

module.exports = async function uploadSarif({ github, env }) {
	const rootPath = requireEnv(env, "SARIF_ROOT");

	if (!fs.existsSync(rootPath)) {
		return { skipped: 0, uploaded: 0 };
	}

	const owner = requireEnv(env, "SARIF_OWNER");
	const repo = requireEnv(env, "SARIF_REPO");
	const commitSha = requireEnv(env, "SARIF_HEAD_SHA");
	const ref = normalizeRef(requireEnv(env, "SARIF_REF"));
	const files = fs
		.readdirSync(rootPath)
		.filter((fileName) => fileName.endsWith(".sarif"))
		.sort();
	let skipped = 0;
	let uploaded = 0;

	for (const fileName of files) {
		const sarifPath = path.join(rootPath, fileName);
		const sarifText = fs.readFileSync(sarifPath, "utf8");

		try {
			await github.request("POST /repos/{owner}/{repo}/code-scanning/sarifs", {
				commit_sha: commitSha,
				owner,
				ref,
				repo,
				sarif: gzipAndEncodeSarif(sarifText),
			});
			uploaded += 1;
		} catch (error) {
			if (isUnsupportedCodeScanningError(error)) {
				console.warn(
					`Skipping SARIF upload for ${owner}/${repo}: ${extractErrorMessage(error)}`,
				);
				skipped += 1;
				continue;
			}

			throw error;
		}
	}

	return { skipped, uploaded };
};

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

function normalizeRef(value) {
	return value.startsWith("refs/") ? value : `refs/heads/${value}`;
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
module.exports.isUnsupportedCodeScanningError = isUnsupportedCodeScanningError;
module.exports.normalizeRef = normalizeRef;
