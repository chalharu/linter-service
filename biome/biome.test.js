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

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createBiomeStub(context) {
	writeExecutable(
		path.join(context.binDir, "biome"),
		`#!/usr/bin/env bash
set -euo pipefail
reporter_file=""
use_sarif=0
for arg in "$@"; do
  case "$arg" in
    --reporter=sarif)
      use_sarif=1
      ;;
    --reporter-file=*)
      reporter_file="\${arg#--reporter-file=}"
      ;;
  esac
done
if [ "$use_sarif" -eq 1 ]; then
  case "\${NATIVE_SARIF_MODE:-success}" in
    success)
      cat > "$reporter_file" <<'EOF'
{"$schema":"https://json.schemastore.org/sarif-2.1.0.json","version":"2.1.0","runs":[{"results":[{"ruleId":"parse","level":"error","message":{"text":"native failure"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/app.ts"},"region":{"startLine":4,"startColumn":3}}}]}],"tool":{"driver":{"rules":[{"id":"parse","shortDescription":{"text":"parse"}}]}}}]}
EOF
      printf 'SARIF summary\\n' >&2
      exit 1
      ;;
    missing)
      printf 'SARIF summary\\n' >&2
      exit 1
      ;;
  esac
fi
printf 'unexpected invocation\\n' >&2
exit 99
`,
	);
}

test("biome/run.sh runs Biome in SARIF mode from the start", () => {
	const context = makeTempRepo("biome-run-native-sarif-");

	createBiomeStub(context);
	writeFile(path.join(context.repoDir, "src/app.ts"), 'console.log("x")\n');

	try {
		const output = execFileSync("bash", [runPath, "src/app.ts"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context),
		});
		const result = JSON.parse(output);
		const sarifPath = path.join(context.runnerTemp, "biome-native.sarif");

		assert.equal(result.exit_code, 1);
		assert.equal(result.details, "SARIF summary");
		assert.equal(fs.existsSync(sarifPath), true);
		assert.equal(
			JSON.parse(fs.readFileSync(sarifPath, "utf8")).runs[0].results[0].ruleId,
			"parse",
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("biome/run.sh fails when native SARIF output is missing", () => {
	const context = makeTempRepo("biome-run-missing-sarif-");

	createBiomeStub(context);
	writeFile(path.join(context.repoDir, "src/app.ts"), 'console.log("x")\n');

	try {
		const sarifPath = path.join(context.runnerTemp, "biome-native.sarif");
		const result = spawnSync("bash", [runPath, "src/app.ts"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				NATIVE_SARIF_MODE: "missing",
			}),
		});

		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/biome native SARIF reporter did not produce output/u,
		);
		assert.equal(result.stdout, "");
		assert.equal(fs.existsSync(sarifPath), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
