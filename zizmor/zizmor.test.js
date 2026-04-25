const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
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
const bashPath = execFileSync("bash", ["-lc", "command -v bash"], {
	encoding: "utf8",
}).trim();

function linkCommand(context, name) {
	const targetPath = path.join(context.binDir, name);
	if (fs.existsSync(targetPath)) {
		return;
	}

	const sourcePath = execFileSync("bash", ["-lc", `command -v ${name}`], {
		encoding: "utf8",
	}).trim();
	fs.symlinkSync(sourcePath, targetPath);
}

function createNodeOnlyEnv(context, extraEnv = {}) {
	fs.rmSync(path.join(context.binDir, "python3"), { force: true });
	fs.rmSync(path.join(context.binDir, "python"), { force: true });
	for (const tool of ["bash", "cat", "dirname", "node", "rm"]) {
		linkCommand(context, tool);
	}

	return {
		...process.env,
		...extraEnv,
		PATH: context.binDir,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createZizmorStub(context) {
	writeExecutable(
		path.join(context.binDir, "zizmor"),
		`#!/usr/bin/env bash
set -euo pipefail
use_sarif=0
for arg in "$@"; do
  case "$arg" in
    --format=sarif)
      use_sarif=1
      ;;
  esac
done
if [ "$use_sarif" -eq 1 ]; then
  case "\${ZIZMOR_STUB_MODE:-success}" in
    success)
      cat <<'EOF'
{"$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"zizmor","version":"1.24.1","rules":[{"id":"zizmor/unpinned-uses","name":"unpinned-uses","helpUri":"https://docs.zizmor.sh/audits/#unpinned-uses"}]}},"results":[{"ruleId":"zizmor/unpinned-uses","level":"error","message":{"text":"unpinned action reference"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":".github/workflows/ci.yml"},"region":{"startLine":5,"startColumn":9}}}]}]}]}
EOF
      exit 0
      ;;
    success_with_stderr)
      cat <<'EOF'
{"$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"zizmor","version":"1.24.1","rules":[{"id":"zizmor/unpinned-uses","name":"unpinned-uses","helpUri":"https://docs.zizmor.sh/audits/#unpinned-uses"}]}},"results":[{"ruleId":"zizmor/unpinned-uses","level":"error","message":{"text":"unpinned action reference"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":".github/workflows/ci.yml"},"region":{"startLine":5,"startColumn":9}}}]}]}]}
EOF
      printf 'zizmor emitted SARIF with a warning on stderr\n' >&2
      exit 0
      ;;
    empty)
      printf 'zizmor failed to produce output\\n' >&2
      exit 2
      ;;
    no_results)
      cat <<'EOF'
{"$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json","version":"2.1.0","runs":[{"tool":{"driver":{"name":"zizmor","version":"1.24.1","rules":[]}},"results":[]}]}
EOF
      exit 0
      ;;
    malformed)
      printf '{not valid json\n'
      printf 'zizmor produced malformed SARIF\n' >&2
      exit 0
      ;;
  esac
fi
printf 'unexpected invocation\\n' >&2
exit 99
`,
	);
}

test("zizmor/run.sh emits SARIF result with findings", () => {
	const context = makeTempRepo("zizmor-run-sarif-");

	createZizmorStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const output = execFileSync(
			bashPath,
			[runPath, ".github/workflows/ci.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createNodeOnlyEnv(context),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.ok(result.sarif, "result should have sarif key");
		assert.equal(
			result.sarif.runs[0].results[0].ruleId,
			"zizmor/unpinned-uses",
		);
		assert.equal(
			result.sarif.runs[0].results[0].locations[0].physicalLocation
				.artifactLocation.uri,
			".github/workflows/ci.yml",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("zizmor/run.sh sets exit_code=0 when no findings", () => {
	const context = makeTempRepo("zizmor-run-no-findings-");

	createZizmorStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const output = execFileSync(
			bashPath,
			[runPath, ".github/workflows/ci.yml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createNodeOnlyEnv(context, { ZIZMOR_STUB_MODE: "no_results" }),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.ok(result.sarif, "result should have sarif key");
		assert.equal(result.sarif.runs[0].results.length, 0);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("zizmor/run.sh fails when native SARIF output is missing", () => {
	const context = makeTempRepo("zizmor-run-missing-sarif-");

	createZizmorStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, { ZIZMOR_STUB_MODE: "empty" }),
		});

		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/zizmor native SARIF output was empty or missing/u,
		);
		assert.equal(result.stdout, "");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("zizmor/run.sh forwards stderr when SARIF output is available", () => {
	const context = makeTempRepo("zizmor-run-stderr-");

	createZizmorStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, {
				ZIZMOR_STUB_MODE: "success_with_stderr",
			}),
		});

		assert.equal(result.status, 0);
		assert.match(
			result.stderr,
			/zizmor emitted SARIF with a warning on stderr/u,
		);
		assert.equal(JSON.parse(result.stdout).exit_code, 1);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("zizmor/run.sh surfaces tool stderr before failing malformed SARIF", () => {
	const context = makeTempRepo("zizmor-run-malformed-sarif-");

	createZizmorStub(context);
	writeFile(
		path.join(context.repoDir, ".github/workflows/ci.yml"),
		"name: ci\non: push\njobs: {}\n",
	);

	try {
		const result = spawnSync(bashPath, [runPath, ".github/workflows/ci.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createNodeOnlyEnv(context, { ZIZMOR_STUB_MODE: "malformed" }),
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /zizmor produced malformed SARIF/u);
		assert.match(result.stderr, /SyntaxError/u);
		assert.equal(result.stdout, "");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
