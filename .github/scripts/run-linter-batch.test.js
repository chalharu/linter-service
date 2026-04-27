const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { formatExecError, runLinterBatch } = require("./run-linter-batch.js");

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
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
		beta: {
			sarif: {
				enabled: false,
			},
		},
	});
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
		assert.match(alphaSummary.comment_body, /✅ 1 \/ 1 file passed\./u);
		assert.match(betaSummary.comment_body, /✅ 1 \/ 1 file passed\./u);
		assert.deepEqual(alphaSummary.checked_projects, []);
		assert.deepEqual(alphaSummary.selected_files, ["alpha.txt"]);
		assert.equal(alphaSummary.status, "success");
		assert.equal(alphaSummary.target_count, 1);
		assert.equal(alphaSummary.passed_target_count, 1);
		assert.equal(alphaSummary.issue_target_count, 0);
		assert.equal(alphaSummary.target_kind, "file");
		assert.deepEqual(betaSummary.checked_projects, []);
		assert.deepEqual(betaSummary.selected_files, ["beta.md"]);
		assert.equal(betaSummary.status, "success");
		assert.equal(betaSummary.target_count, 1);
		assert.equal(betaSummary.passed_target_count, 1);
		assert.equal(betaSummary.issue_target_count, 0);
		assert.equal(betaSummary.target_kind, "file");
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch continues after an install failure and reports infrastructure failure", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeFile(path.join(workspace.sourceRepositoryPath, "beta.md"), "# beta\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
		beta: {
			sarif: {
				enabled: false,
			},
		},
	});
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
		assert.match(
			alphaSummary.comment_body,
			/Matched 1 file, but the workflow failed before diagnostics were produced\./u,
		);
		assert.match(
			alphaSummary.comment_body,
			/<details><summary>Details<\/summary>\n\n```text\nalpha install step failed\./u,
		);
		assert.match(alphaSummary.details_text, /^alpha install step failed\./u);
		assert.match(alphaSummary.details_text, /\nstderr:\ninstall boom$/u);
		assert.equal(alphaSummary.status, "infra_failure");
		assert.equal(betaSummary.conclusion, "success");
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch omits secret-like captured output from infrastructure failure summaries", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
echo "GITHUB_TOKEN=ghp_123456789012345678901234567890123456" >&2
echo "https://user:pass123@registry.example.com/pkg" >&2
echo "Authorization: Bearer short_token_val" >&2
echo "//registry.npmjs.org/:_authToken=npm_secret_value" >&2
echo "npm_abcdefghijklmnopqrstuvwxyz012345678901234567890123456789" >&2
echo "hvs.abcdefghijklmnopqrstuvwxyz012345678901234567890123456789" >&2
exit 1
`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"should-not-run","exit_code":0}\\n'
`,
	});

	try {
		runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		assert.match(alphaSummary.details_text, /^alpha install step failed\./u);
		assert.match(alphaSummary.details_text, /stderr omitted \(\d+ chars\)/u);
		assert.doesNotMatch(alphaSummary.details_text, /GITHUB_TOKEN/u);
		assert.doesNotMatch(alphaSummary.details_text, /ghp_/u);
		assert.doesNotMatch(alphaSummary.details_text, /registry\.example\.com/u);
		assert.doesNotMatch(alphaSummary.details_text, /Bearer short_token_val/u);
		assert.doesNotMatch(alphaSummary.details_text, /_authToken/u);
		assert.doesNotMatch(alphaSummary.details_text, /npm_abcdefghijklmnopqrstuvwxyz/u);
		assert.doesNotMatch(alphaSummary.details_text, /hvs\./u);
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch keeps safe long-path diagnostics in infrastructure failure summaries", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
echo "error: could not open /runner/work/project/linter-service/alpha/really/long/path/to/generated/output/file.txt" >&2
exit 1
`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"should-not-run","exit_code":0}\\n'
`,
	});

	try {
		runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		assert.match(
			alphaSummary.details_text,
			/error: could not open \/runner\/work\/project\/linter-service\/alpha\/really\/long\/path\/to\/generated\/output\/file\.txt/u,
		);
		assert.doesNotMatch(alphaSummary.details_text, /stderr omitted/u);
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch keeps safe long package-name diagnostics in infrastructure failure summaries", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
echo "error: package prettier-plugin-sort-imports-alphabetical not found" >&2
exit 1
`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"should-not-run","exit_code":0}\\n'
`,
	});

	try {
		runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		assert.match(
			alphaSummary.details_text,
			/error: package prettier-plugin-sort-imports-alphabetical not found/u,
		);
		assert.doesNotMatch(alphaSummary.details_text, /stderr omitted/u);
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch preserves warning-only summaries as successful conclusions", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: true,
			},
		},
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
:`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"warning[ALPHA1]: alpha warning","exit_code":0,"warning_count":1}\\n'
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
			linterNames: ["alpha"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		assert.equal(result.infrastructureFailures, 0);
		assert.equal(result.linters[0].conclusion, "success");

		const alphaSummary = JSON.parse(
			fs.readFileSync(
				path.join(workspace.runnerTemp, "linter-summary-alpha.json"),
				"utf8",
			),
		);
		assert.equal(alphaSummary.conclusion, "success");
		assert.equal(alphaSummary.status, "warning");
		assert.match(
			alphaSummary.comment_body,
			/⚠️ Checked 1 file; 1 file reported warnings\./u,
		);
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("runLinterBatch allows larger linter result payloads", () => {
	const workspace = createTempWorkspace();
	writeFile(path.join(workspace.sourceRepositoryPath, "alpha.txt"), "alpha\n");
	writeLinterConfig(workspace.linterConfigPath, {
		alpha: {
			sarif: {
				enabled: false,
			},
		},
	});
	writeFakeLinter(workspace.linterServicePath, {
		name: "alpha",
		installScript: `#!/usr/bin/env bash
set -euo pipefail
:`,
		pattern: "^alpha\\.txt$",
		runScript: `#!/usr/bin/env bash
set -euo pipefail
printf '{"details":"alpha ok","exit_code":0}\\n'
`,
	});
	const realExecFileSync = execFileSync;
	let recordedRunOptions = null;

	try {
		runLinterBatch({
			baseEnv: {
				...process.env,
				PATH: process.env.PATH || "",
			},
			contextPath: workspace.contextPath,
			execFileSyncImpl(command, args, options) {
				if (
					command === "bash" &&
					Array.isArray(args) &&
					args[0] === path.join(workspace.linterServicePath, "alpha", "run.sh")
				) {
					recordedRunOptions = options;
				}

				return realExecFileSync(command, args, options);
			},
			linterConfigPath: workspace.linterConfigPath,
			linterNames: ["alpha"],
			linterServicePath: workspace.linterServicePath,
			runnerTemp: workspace.runnerTemp,
			sourceRepositoryPath: workspace.sourceRepositoryPath,
		});

		assert.equal(recordedRunOptions?.maxBuffer, 16 * 1024 * 1024);
	} finally {
		cleanupTempWorkspace(workspace.tempDir);
	}
});

test("formatExecError suppresses raw stdout and stderr contents", () => {
	const formatted = formatExecError({
		message: "Command failed: bash run.sh\nsecret stderr",
		stderr: "top secret stderr",
		stdout: "top secret stdout",
	});

	assert.match(formatted, /^\nCommand failed: bash run\.sh/u);
	assert.match(formatted, /stdout omitted \(17 chars\)/u);
	assert.match(formatted, /stderr omitted \(17 chars\)/u);
	assert.doesNotMatch(formatted, /top secret/u);
});
