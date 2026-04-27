const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const runPath = path.join(__dirname, "run.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createShellcheckStub(binDir) {
	writeExecutable(
		path.join(binDir, "shellcheck"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$SHELLCHECK_ARGS_LOG"
if [ -n "\${SHELLCHECK_FAIL:-}" ]; then
  cat <<'EOF'
{"comments":[{"file":"script.sh","line":3,"column":6,"level":"info","code":2086,"message":"Double quote to prevent globbing and word splitting."}]}
EOF
  exit 1
fi
cat <<'EOF'
{"comments":[]}
EOF
`,
	);
}

test("shellcheck run emits embedded sarif from json1 output", () => {
	const context = makeTempRepo("shellcheck-run-");
	const argsLog = path.join(context.tempDir, "shellcheck-args.log");

	createShellcheckStub(context.binDir);
	writeFile(path.join(context.repoDir, "script.sh"), "echo $foo\n");

	try {
		const output = execFileSync("bash", [runPath, "script.sh"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				SHELLCHECK_ARGS_LOG: argsLog,
				SHELLCHECK_FAIL: "1",
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.sarif.runs[0].results[0].ruleId, "SC2086");
		assert.match(
			fs.readFileSync(argsLog, "utf8"),
			/--format json1 -x -P SCRIPTDIR script\.sh/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
