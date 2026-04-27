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

function createRuffStub(binDir) {
	writeExecutable(
		path.join(binDir, "ruff"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RUFF_ARGS_LOG"
output_file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-file" ]; then
    output_file="$arg"
  fi
  prev="$arg"
done
if [ -z "$output_file" ]; then
  echo "missing --output-file" >&2
  exit 2
fi
if [ -n "\${RUFF_FAIL:-}" ]; then
  cat > "$output_file" <<'EOF'
{"version":"2.1.0","runs":[{"results":[{"level":"warning","locations":[{"physicalLocation":{"artifactLocation":{"uri":"main.py"},"region":{"startLine":1,"startColumn":8}}}],"message":{"text":"unused import: os"},"ruleId":"F401"}],"tool":{"driver":{"rules":[{"id":"F401","name":"F401","shortDescription":{"text":"F401"}}]}}}]}
EOF
  exit 1
fi
cat > "$output_file" <<'EOF'
{"version":"2.1.0","runs":[{"results":[],"tool":{"driver":{"rules":[]}}}]}
EOF
`,
	);
}

test("ruff run emits embedded sarif output", () => {
	const context = makeTempRepo("ruff-run-");
	const ruffArgsLog = path.join(context.tempDir, "ruff-args.log");

	createRuffStub(context.binDir);
	writeFile(path.join(context.repoDir, "main.py"), "import os\n");

	try {
		const output = execFileSync("bash", [runPath, "main.py"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				RUFF_ARGS_LOG: ruffArgsLog,
				RUFF_FAIL: "1",
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.sarif.runs[0].results[0].ruleId, "F401");
		assert.match(
			fs.readFileSync(ruffArgsLog, "utf8"),
			/check --force-exclude --no-cache --output-format sarif --output-file/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
