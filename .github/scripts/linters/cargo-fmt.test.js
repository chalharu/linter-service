const {
	assert,
	defineCommonCargoManifestTests,
	fs,
	path,
	writeExecutable,
} = require("./cargo-linter-test-lib");

const scriptPath = path.join(__dirname, "cargo-fmt.sh");

function createCargoStub(binDir) {
	writeExecutable(
		path.join(binDir, "cargo"),
		`#!/usr/bin/env bash
set -euo pipefail
manifest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-path)
      manifest="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\\n' "$manifest" >> "$CARGO_MANIFEST_LOG"
printf 'checked %s\\n' "$manifest"
if [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ]; then
  printf 'unformatted %s\\n' "$manifest" >&2
  exit 1
fi
`,
	);
}

defineCommonCargoManifestTests({
	scriptPath,
	tempPrefix: "cargo-fmt-",
	toolName: "cargo-fmt.sh",
	setupTooling(context) {
		const cargoManifestLog = path.join(context.tempDir, "cargo-manifests.log");
		createCargoStub(context.binDir);
		return {
			cargoManifestLog,
			env: {
				CARGO_MANIFEST_LOG: cargoManifestLog,
			},
		};
	},
	assertGroupedResult({ result, tooling }) {
		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(tooling.cargoManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(
			result.details,
			/cargo fmt --check --manifest-path Cargo\.toml/,
		);
		assert.match(
			result.details,
			/cargo fmt --check --manifest-path crates\/member\/Cargo\.toml/,
		);
	},
	assertMissingManifestResult({ pathValue, result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(
			result.details,
			new RegExp(pathValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.equal(fs.existsSync(tooling.cargoManifestLog), false);
	},
	continueFailureEnv: {
		FAIL_MANIFEST: "Cargo.toml",
	},
	assertContinueAfterFailureResult({ result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(tooling.cargoManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(result.details, /unformatted Cargo\.toml/);
		assert.match(
			result.details,
			/cargo fmt --check --manifest-path crates\/member\/Cargo\.toml/,
		);
	},
});
