const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const scriptPath = path.join(__dirname, "artifact-passphrase.sh");
const secureArtifactPath = path.join(__dirname, "secure-artifact.sh");

test("artifact-passphrase.sh derives the expected HMAC for the workflow run", () => {
	const output = execFileSync("bash", [scriptPath], {
		encoding: "utf8",
		env: {
			...process.env,
			CHECKER_PRIVATE_KEY: "test-private-key",
			GITHUB_RUN_ID: "123456789",
		},
	});

	const expected = createHmac("sha256", "test-private-key")
		.update("123456789")
		.digest("hex");

	assert.equal(output, expected);
});

test("secure-artifact.sh round-trips detect-targets context with the derived passphrase", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "artifact-passphrase-"),
	);
	const inputPath = path.join(tempDir, "detect-targets-context.json");
	const encryptedPath = path.join(tempDir, "detect-targets-context.json.enc");
	const decryptedPath = path.join(
		tempDir,
		"detect-targets-context.decrypted.json",
	);

	fs.writeFileSync(
		inputPath,
		JSON.stringify(
			{
				pr_owner: "chalharu",
				pr_repo: "linter-service",
				source_head_sha: "abc123",
			},
			null,
			2,
		),
		"utf8",
	);

	const passphrase = execFileSync("bash", [scriptPath], {
		encoding: "utf8",
		env: {
			...process.env,
			CHECKER_PRIVATE_KEY: "test-private-key",
			GITHUB_RUN_ID: "123456789",
		},
	});

	try {
		execFileSync(
			"bash",
			[secureArtifactPath, "encrypt", inputPath, encryptedPath],
			{
				env: {
					...process.env,
					ARTIFACT_PASSPHRASE: passphrase,
				},
			},
		);
		execFileSync(
			"bash",
			[secureArtifactPath, "decrypt", encryptedPath, decryptedPath],
			{
				env: {
					...process.env,
					ARTIFACT_PASSPHRASE: passphrase,
				},
			},
		);

		assert.equal(
			fs.readFileSync(decryptedPath, "utf8"),
			fs.readFileSync(inputPath, "utf8"),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
