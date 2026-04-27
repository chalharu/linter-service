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
node - "$@" <<'NODE'
const fs = require("node:fs");

const args = process.argv.slice(2);

if (args.length === 3) {
\tconst [, exitCode, outputFile] = args;
\tconst details = fs.existsSync(outputFile)
\t\t? fs.readFileSync(outputFile, "utf8").trim()
\t\t: "";
\tprocess.stdout.write(
\t\tJSON.stringify({ details, exit_code: Number.parseInt(exitCode, 10) }),
\t);
\tprocess.exit(0);
}

if (args.length === 4) {
\tconst [, exitCode, resultKey, jsonFile] = args;
\tprocess.stdout.write(
\t\tJSON.stringify({
\t\t\texit_code: Number.parseInt(exitCode, 10),
\t\t\t[resultKey]: JSON.parse(fs.readFileSync(jsonFile, "utf8")),
\t\t}),
\t);
\tprocess.exit(0);
}

if (args.length === 2) {
\tconst [, sarifFile] = args;
\tconst sarif = JSON.parse(fs.readFileSync(sarifFile, "utf8"));
\tconst hasResults = (sarif.runs ?? []).some(
\t\t(run) => (run?.results?.length ?? 0) > 0,
\t);
\tprocess.stdout.write(
\t\tJSON.stringify({
\t\t\texit_code: hasResults ? 1 : 0,
\t\t\tsarif,
\t\t}),
\t);
\tprocess.exit(0);
}

process.stderr.write(
\t'unsupported python stub invocation: ' + JSON.stringify(args) + '\\n',
);
process.exit(1);
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

function readPinnedVersion(scriptPath, variableName) {
	const source = fs.readFileSync(scriptPath, "utf8");
	const match = source.match(new RegExp(`${variableName}="([^"\\n]+)"`, "u"));

	assert.ok(match, `Expected ${variableName} in ${scriptPath}`);
	return match[1];
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
	readPinnedVersion,
	writeExecutable,
	writeFile,
};
