const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { listRepositoryFiles, runFromEnv } = require("./select-lint-targets.js");

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

function writeExecutable(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
	fs.chmodSync(filePath, 0o755);
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

test("expands to all matching repository files when a config trigger changes", () => {
	const context = makeTempRepo();
	const contextPath = path.join(context.runnerTemp, "context.json");
	const outputPath = path.join(context.runnerTemp, "selected-files.txt");
	const patternPath = path.join(context.runnerTemp, "patterns.txt");

	fs.mkdirSync(path.join(context.repoDir, "docs"), { recursive: true });
	fs.writeFileSync(path.join(context.repoDir, ".textlintrc"), "{}\n", "utf8");
	fs.writeFileSync(
		path.join(context.repoDir, "README.md"),
		"# README\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(context.repoDir, "docs", "guide.md"),
		"# Guide\n",
		"utf8",
	);
	fs.writeFileSync(path.join(context.repoDir, "notes.txt"), "note\n", "utf8");
	fs.writeFileSync(
		contextPath,
		JSON.stringify({
			changed_files: [".textlintrc"],
		}),
		"utf8",
	);
	fs.writeFileSync(patternPath, "\\.(?:md|txt)$\n", "utf8");
	writeExecutable(
		path.join(context.repoDir, "textlint", "config_trigger_patterns.sh"),
		"#!/usr/bin/env bash\nprintf '%s\\n' '^\\.textlintrc$'\n",
	);

	try {
		const result = runFromEnv({
			CONTEXT_PATH: contextPath,
			LINTER_NAME: "textlint",
			LINTER_SERVICE_PATH: context.repoDir,
			OUTPUT_PATH: outputPath,
			PATTERN_PATH: patternPath,
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.deepEqual(result.selectedFiles, [
			"README.md",
			"docs/guide.md",
			"notes.txt",
		]);
		assert.equal(
			fs.readFileSync(outputPath, "utf8"),
			"README.md\ndocs/guide.md\nnotes.txt\n",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("expands repository selection when a config trigger also matches target patterns", () => {
	const context = makeTempRepo();
	const contextPath = path.join(context.runnerTemp, "context.json");
	const outputPath = path.join(context.runnerTemp, "selected-files.txt");
	const patternPath = path.join(context.runnerTemp, "patterns.txt");

	fs.mkdirSync(path.join(context.repoDir, "docs"), { recursive: true });
	fs.writeFileSync(path.join(context.repoDir, ".yamllint.yml"), "{}\n", "utf8");
	fs.writeFileSync(
		path.join(context.repoDir, "app.yaml"),
		"name: app\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(context.repoDir, "docs", "guide.yml"),
		"title: guide\n",
		"utf8",
	);
	fs.writeFileSync(
		contextPath,
		JSON.stringify({
			changed_files: [".yamllint.yml"],
		}),
		"utf8",
	);
	fs.writeFileSync(patternPath, "\\.(?:yaml|yml)$\n", "utf8");
	writeExecutable(
		path.join(context.repoDir, "yamllint", "config_trigger_patterns.sh"),
		"#!/usr/bin/env bash\nprintf '%s\\n' '^\\.yamllint(?:\\.(?:yaml|yml))?$'\n",
	);

	try {
		const result = runFromEnv({
			CONTEXT_PATH: contextPath,
			LINTER_NAME: "yamllint",
			LINTER_SERVICE_PATH: context.repoDir,
			OUTPUT_PATH: outputPath,
			PATTERN_PATH: patternPath,
			SOURCE_REPOSITORY_PATH: context.repoDir,
		});

		assert.deepEqual(result.selectedFiles, [
			".yamllint.yml",
			"app.yaml",
			"docs/guide.yml",
		]);
		assert.equal(
			fs.readFileSync(outputPath, "utf8"),
			".yamllint.yml\napp.yaml\ndocs/guide.yml\n",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("listRepositoryFiles skips directory symlinks in filesystem fallback mode", () => {
	const context = makeTempRepo();
	const realDir = path.join(context.repoDir, "docs");
	const linkDir = path.join(context.repoDir, "docs-link");

	fs.mkdirSync(realDir, { recursive: true });
	fs.writeFileSync(path.join(realDir, "guide.md"), "# Guide\n", "utf8");

	try {
		fs.symlinkSync(realDir, linkDir, "dir");

		assert.deepEqual(listRepositoryFiles(context.repoDir), ["docs/guide.md"]);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
