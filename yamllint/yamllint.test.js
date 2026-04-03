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

function createYamllintStub(binDir) {
	writeExecutable(
		path.join(binDir, "yamllint"),
		`#!/usr/bin/env bash
set -euo pipefail
config_path=""
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c)
      config_path="$2"
      shift 2
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
printf '%s\\n' "$config_path" > "$YAMLLINT_CONFIG_LOG"
printf '%s\\n' "\${args[*]}" > "$YAMLLINT_ARGS_LOG"
if ! grep -Fqx '    check-keys: false' "$config_path"; then
  echo 'invalid config: rule "truthy": should be either "enable", "disable" or a mapping' >&2
  exit 1
fi
printf 'linted %s\\n' "\${args[*]}"
`,
	);
}

test("yamllint.sh falls back to a temp default config when the repo has none", () => {
	const context = makeTempRepo("yamllint-default-config-");
	const configLog = path.join(context.tempDir, "yamllint-config.log");
	const argsLog = path.join(context.tempDir, "yamllint-args.log");
	const defaultConfigPath = path.join(context.runnerTemp, "yamllint.yaml");

	createYamllintStub(context.binDir);
	writeFile(path.join(context.repoDir, "workflow.yml"), "name: demo\n");

	try {
		const output = execFileSync("bash", [runPath, "workflow.yml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				YAMLLINT_ARGS_LOG: argsLog,
				YAMLLINT_CONFIG_LOG: configLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(fs.readFileSync(configLog, "utf8").trim(), defaultConfigPath);
		assert.equal(fs.readFileSync(argsLog, "utf8").trim(), "workflow.yml");
		assert.match(result.details, /linted workflow\.yml/);
		assert.match(
			fs.readFileSync(defaultConfigPath, "utf8"),
			/truthy:\n {4}check-keys: false\n/u,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
