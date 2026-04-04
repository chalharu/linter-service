const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runLinterBatch } = require("./run-linter-batch.js");

function createTempWorkspace() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-linter-batch-"));
	const linterServicePath = path.join(tempDir, "linter-service");
	const sourceRepositoryPath = path.join(tempDir, "source-repo");
	const runnerTemp = path.join(tempDir, "runner-temp");
	const contextPath = path.join(runnerTemp, "context.json");
	const linterConfigPath = path.join(linterServicePath, "linters.json");

	fs.mkdirSync(path.join(linterServicePath, ".github", "scripts"), {
		recursive: true,
	});
	fs.mkdirSync(sourceRepositoryPath, { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.writeFileSync(
		contextPath,
		JSON.stringify({ changed_files: ["alpha.txt", "beta.md"] }),
		"utf8",
	);

	return {
		contextPath,
		linterConfigPath,
		linterServicePath,
		runnerTemp,
		sourceRepositoryPath,
		tempDir,
	};
}

function cleanupTempWorkspace(tempDir) {
	fs.rmSync(tempDir, { force: true, recursive: true });
}

function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function writeExecutable(filePath, content) {
	writeFile(filePath, content);
	fs.chmodSync(filePath, 0o755);
}

function writeLinterConfig(linterConfigPath, linters) {
	writeFile(linterConfigPath, JSON.stringify({ linters }, null, 2));
}

function writeFakeLinter(
	linterServicePath,
	{ name, installScript, pattern, runScript },
) {
	const linterDir = path.join(linterServicePath, name);
	writeExecutable(
		path.join(linterDir, "patterns.sh"),
		`#!/usr/bin/env bash\nprintf '%s\\n' '${pattern}'\n`,
	);
	writeExecutable(path.join(linterDir, "install.sh"), installScript);
	writeExecutable(path.join(linterDir, "run.sh"), runScript);
}

test("runLinterBatch executes multiple linters and preserves workflow env updates", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeFile(path.join(workspace.sourceRepositoryPath, "beta.md"), "# beta\n");
	writeLinterConfig(workspace.linterConfigPath, [
		{
			name: "alpha",
			heading: "### alpha",
			no_files: "no files",
			success: "alpha ok",
			failure: "alpha failed",
			infra_failure: "alpha infra failed",
			details_fallback: "alpha fallback",
			sarif: {
				enabled: false,
			},
		},
		{
			name: "beta",
			heading: "### beta",
			no_files: "no files",
			success: "beta ok",
			failure: "beta failed",
			infra_failure: "beta infra failed",
			details_fallback: "beta fallback",
			sarif: {
				enabled: false,
			},
		},
	]);
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RUNNER_TEMP/alpha-bin"
cat > "$RUNNER_TEMP/alpha-bin/alpha-helper" <<'EOF'
#!/usr/bin/env bash
printf '%s\\n' helper-ready
EOF
chmod +x "$RUNNER_TEMP/alpha-bin/alpha-helper"
printf '%s\\n' "$RUNNER_TEMP/alpha-bin" >> "$GITHUB_PATH"
printf '%s\\n' "ALPHA_READY=yes" >> "$GITHUB_ENV"
`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"alpha:%s:%s:%s","exit_code":0}\\n' "$ALPHA_READY" "$(alpha-helper)" "$1"
`,
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "beta",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "BETA_READY=yes" >> "$GITHUB_ENV"
`,
		pattern: "^beta\\.md$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"beta:%s:%s","exit_code":0}\\n' "$BETA_READY" "$1"
`,
	});

	try {
		const result = runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha", "beta"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		assert.equal(result.infrastructureFailures, 0);
		assert.equal(result.linters.length, 2);
		assert.equal(result.linters[0].conclusion, "success");
		assert.equal(result.linters[1].conclusion, "success");

		const alphaResult = JSON.parse(
			fs.readFileSync(
				path.join(
					workspace.runnerTemp,
					"linter-batch",
					"alpha",
					"linter-result.json",
				),
				"utf8",
			),
		);
		const betaResult = JSON.parse(
			fs.readFileSync(
				path.join(
					workspace.runnerTemp,
					"linter-batch",
					"beta",
					"linter-result.json",
				),
				"utf8",
			),
		);
		assert.equal(alphaResult.details, "alpha:yes:helper-ready:alpha.txt");
		assert.equal(betaResult.details, "beta:yes:beta.md");

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		const betaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-beta.json"),
				"utf8",
			),
		);
		assert.equal(alphaSummary.conclusion, "success");
		assert.equal(betaSummary.conclusion, "success");
		assert.match(alphaSummary.comment_body, /alpha ok/u);
		assert.match(betaSummary.comment_body, /beta ok/u);
		assert.deepEqual(alphaSummary.checked_projects, []);
		assert.deepEqual(alphaSummary.selected_files, ["alpha.txt"]);
		assert.equal(alphaSummary.status, "success");
		assert.equal(alphaSummary.target_summary, "1 file(s)");
		assert.deepEqual(betaSummary.checked_projects, []);
		assert.deepEqual(betaSummary.selected_files, ["beta.md"]);
		assert.equal(betaSummary.status, "success");
		assert.equal(betaSummary.target_summary, "1 file(s)");
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch continues after an install failure and reports infrastructure failure", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeFile(path.join(workspace.sourceRepositoryPath, "beta.md"), "# beta\n");
	writeLinterConfig(workspace.linterConfigPath, [
		{
			name: "alpha",
			heading: "### alpha",
			no_files: "no files",
			success: "alpha ok",
			failure: "alpha failed",
			infra_failure: "alpha infra failed",
			details_fallback: "alpha fallback",
			sarif: {
				enabled: false,
			},
		},
		{
			name: "beta",
			heading: "### beta",
			no_files: "no files",
			success: "beta ok",
			failure: "beta failed",
			infra_failure: "beta infra failed",
			details_fallback: "beta fallback",
			sarif: {
				enabled: false,
			},
		},
	]);
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
echo "install boom" >&2
exit 1
`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"should-not-run","exit_code":0}\\n'
`,
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "beta",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
:
`,
		pattern: "^beta\\.md$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"beta ok","exit_code":0}\\n'
`,
	});

	try {
		const result = runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha", "beta"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		assert.equal(result.infrastructureFailures, 1);
		assert.equal(result.linters[0].installOutcome, "failure");
		assert.equal(result.linters[0].runOutcome, "skipped");
		assert.equal(result.linters[1].conclusion, "success");

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		const betaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-beta.json"),
				"utf8",
			),
		);
		assert.equal(alphaSummary.conclusion, "failure");
		assert.deepEqual(alphaSummary.checked_projects, []);
		assert.deepEqual(alphaSummary.selected_files, ["alpha.txt"]);
		assert.match(alphaSummary.comment_body, /alpha infra failed/u);
		assert.equal(alphaSummary.status, "infra_failure");
		assert.equal(betaSummary.conclusion, "success");
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});
