const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function writeExecutable(filePath, content) {
	fs.writeFileSync(filePath, content, "utf8");
	fs.chmodSync(filePath, 0o755);
}

function createJsonPythonStub(binDir) {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
exit_code="$2"
output_file="$3"
node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");
const [exitCode, outputFile] = process.argv.slice(2);
const details = fs.existsSync(outputFile)
\t? fs.readFileSync(outputFile, "utf8").trim()
\t: "";
process.stdout.write(JSON.stringify({ details, exit_code: Number(exitCode) }));
NODE
`,
	);
}

function makeTempRepo(prefix) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const repoDir = path.join(tempDir, "repo");
	const runnerTemp = path.join(tempDir, "runner");
	const binDir = path.join(tempDir, "bin");

	fs.mkdirSync(repoDir, { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });

	createJsonPythonStub(binDir);

	return { binDir, repoDir, runnerTemp, tempDir };
}

function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function cleanupTempRepo(tempDir) {
	fs.rmSync(tempDir, { recursive: true, force: true });
}

function createScriptEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function populateTwoPackageRepo(repoDir) {
	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(path.join(repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);
}

function defineCommonCargoManifestTests({
	assertContinueAfterFailureResult,
	assertGroupedResult,
	assertMissingManifestResult,
	continueFailureEnv,
	runPath,
	scriptPath,
	setupTooling,
	tempPrefix,
	toolName,
}) {
	const effectiveRunPath = runPath || scriptPath;

	test(`${toolName} groups changed Rust files by nearest Cargo.toml`, () => {
		const context = makeTempRepo(`${tempPrefix}grouped-`);
		const tooling = setupTooling(context);

		populateTwoPackageRepo(context.repoDir);

		try {
			const output = execFileSync(
				"bash",
				[
					effectiveRunPath,
					"src/lib.rs",
					"src/main.rs",
					"crates/member/src/lib.rs",
				],
				{
					cwd: context.repoDir,
					encoding: "utf8",
					env: createScriptEnv(context, tooling.env),
				},
			);
			const result = JSON.parse(output);

			assertGroupedResult({ context, result, tooling });
		} finally {
			cleanupTempRepo(context.tempDir);
		}
	});

	test(`${toolName} reports Rust files outside Cargo packages`, () => {
		const context = makeTempRepo(`${tempPrefix}missing-manifest-`);
		const tooling = setupTooling(context);

		writeFile(path.join(context.repoDir, "standalone.rs"), "fn main() {}\n");

		try {
			const output = execFileSync("bash", [effectiveRunPath, "standalone.rs"], {
				cwd: context.repoDir,
				encoding: "utf8",
				env: createScriptEnv(context, tooling.env),
			});
			const result = JSON.parse(output);

			assertMissingManifestResult({
				context,
				pathValue: "standalone.rs",
				result,
				tooling,
			});
		} finally {
			cleanupTempRepo(context.tempDir);
		}
	});

	test(`${toolName} handles absolute Rust file paths outside Cargo packages`, () => {
		const context = makeTempRepo(`${tempPrefix}absolute-missing-manifest-`);
		const tooling = setupTooling(context);
		const standalonePath = path.join(context.tempDir, "standalone.rs");

		writeFile(standalonePath, "fn main() {}\n");

		try {
			const output = execFileSync("bash", [effectiveRunPath, standalonePath], {
				cwd: context.repoDir,
				encoding: "utf8",
				env: createScriptEnv(context, tooling.env),
				timeout: 1000,
			});
			const result = JSON.parse(output);

			assertMissingManifestResult({
				context,
				pathValue: standalonePath,
				result,
				tooling,
			});
		} finally {
			cleanupTempRepo(context.tempDir);
		}
	});

	test(`${toolName} continues checking later Cargo packages after one failure`, () => {
		const context = makeTempRepo(`${tempPrefix}continue-`);
		const tooling = setupTooling(context);

		populateTwoPackageRepo(context.repoDir);

		try {
			const output = execFileSync(
				"bash",
				[effectiveRunPath, "src/lib.rs", "crates/member/src/lib.rs"],
				{
					cwd: context.repoDir,
					encoding: "utf8",
					env: createScriptEnv(context, {
						...tooling.env,
						...continueFailureEnv,
					}),
				},
			);
			const result = JSON.parse(output);

			assertContinueAfterFailureResult({ context, result, tooling });
		} finally {
			cleanupTempRepo(context.tempDir);
		}
	});
}

module.exports = {
	assert,
	cleanupTempRepo,
	defineCommonCargoManifestTests,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
};
