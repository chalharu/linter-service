const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runFromEnv } = require("./select-lint-targets.js");

function makeTempRepo() {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "select-lint-targets-"),
	);
	const repoDir = path.join(tempDir, "repo");
	const runnerTemp = path.join(tempDir, "runner");
	fs.mkdirSync(path.join(repoDir, ".github"), { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });
	return { repoDir, runnerTemp, tempDir };
}

function cleanupTempRepo(tempDir) {
	fs.rmSync(tempDir, { force: true, recursive: true });
}

test("writes selected pull request files and the count output", () => {
	const context = makeTempRepo();
	const contextPath = path.join(context.runnerTemp, "context.json");
	const outputPath = path.join(context.runnerTemp, "selected-files.txt");
	const patternPath = path.join(context.runnerTemp, "patterns.txt");
	const githubOutputPath = path.join(context.runnerTemp, "github-output.txt");

	fs.writeFileSync(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				global: {
					exclude_paths: ["**/tests/*/target/**", "**/tests/*/sarif.json"],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		contextPath,
		JSON.stringify({
			changed_files: [
				".github/workflows/pass.yml",
				"actionlint/tests/fail/target/workflow.yml",
				"actionlint/tests/fail/sarif.json",
				"README.md",
			],
		}),
		"utf8",
	);
	fs.writeFileSync(
		patternPath,
		"^\\.github\\/workflows\\/.+\\.(?:yaml|yml)$\n",
		"utf8",
	);

	try {
		const result = runFromEnv({
			CONTEXT_PATH: contextPath,
			GITHUB_OUTPUT: githubOutputPath,
			LINTER_NAME: "actionlint",
			OUTPUT_PATH: outputPath,
			PATTERN_PATH: patternPath,
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.deepEqual(result.selectedFiles, [".github/workflows/pass.yml"]);
		assert.equal(
			fs.readFileSync(outputPath, "utf8"),
			".github/workflows/pass.yml\n",
		);
		assert.match(fs.readFileSync(githubOutputPath, "utf8"), /count=1/u);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("writes selected push files from the full tracked file list", () => {
	const context = makeTempRepo();
	const contextPath = path.join(context.runnerTemp, "context.json");
	const outputPath = path.join(context.runnerTemp, "selected-files.txt");
	const patternPath = path.join(context.runnerTemp, "patterns.txt");
	const githubOutputPath = path.join(context.runnerTemp, "github-output.txt");

	fs.writeFileSync(
		path.join(context.repoDir, ".github", "linter-service.json"),
		JSON.stringify(
			{
				global: {
					exclude_paths: ["**/tests/*/target/**", "**/tests/*/sarif.json"],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	fs.writeFileSync(
		contextPath,
		JSON.stringify({
			changed_files: [
				"README.md",
				"biome/tests/pass/result.json",
				"biome/tests/pass/sarif.json",
				"biome/tests/pass/target/package.json",
				"package-lock.json",
			],
		}),
		"utf8",
	);
	fs.writeFileSync(patternPath, "\\.json$\n", "utf8");

	try {
		const result = runFromEnv({
			CONTEXT_PATH: contextPath,
			GITHUB_OUTPUT: githubOutputPath,
			LINTER_NAME: "biome",
			OUTPUT_PATH: outputPath,
			PATTERN_PATH: patternPath,
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.deepEqual(result.selectedFiles, [
			"biome/tests/pass/result.json",
			"package-lock.json",
		]);
		assert.equal(
			fs.readFileSync(outputPath, "utf8"),
			"biome/tests/pass/result.json\npackage-lock.json\n",
		);
		assert.match(fs.readFileSync(githubOutputPath, "utf8"), /count=2/u);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
