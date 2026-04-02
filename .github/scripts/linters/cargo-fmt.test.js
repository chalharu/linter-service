const test = require("node:test");
const {
	assert,
	cleanupTempRepo,
	defineCommonCargoManifestTests,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("./cargo-linter-test-lib");

const { execFileSync } = require("node:child_process");

const scriptPath = path.join(__dirname, "cargo-fmt.sh");

function createCargoStub(binDir) {
	writeExecutable(
		path.join(binDir, "cargo"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "fmt" ] && [ "\${2-}" = "--version" ]; then
  echo "cargo-fmt 0.0.0"
  exit 0
fi
if [ "\${1-}" = "metadata" ]; then
  shift
  manifest=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --manifest-path|--format-version)
        if [ "$1" = "--manifest-path" ]; then
          manifest="$2"
        fi
        shift 2
        ;;
      --no-deps)
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  if [ -z "$manifest" ]; then
    echo "missing --manifest-path" >&2
    exit 1
  fi
  current_dir=$(dirname "$manifest")
  workspace_dir="$current_dir"
  search_dir="$current_dir"
  while :; do
    candidate="$search_dir/Cargo.toml"
    if [ -f "$candidate" ] && grep -Eq '^\\[workspace\\]' "$candidate"; then
      workspace_dir="$search_dir"
      break
    fi
    if [ "$search_dir" = "." ] || [ "$search_dir" = "/" ]; then
      break
    fi
    search_dir=$(dirname "$search_dir")
  done
  workspace_root=$(cd "$workspace_dir" && pwd)
  node - "$workspace_root" <<'NODE'
const [workspaceRoot] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ workspace_root: workspaceRoot }));
NODE
  exit 0
fi
manifest=""
all_flag=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-path)
      manifest="$2"
      shift 2
      ;;
    --all)
      all_flag=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\\n' "$manifest" >> "$CARGO_MANIFEST_LOG"
if [ -f "$manifest" ] && grep -Eq '^\\[workspace\\]' "$manifest" && ! grep -Eq '^\\[package\\]' "$manifest"; then
  if [ "$all_flag" -ne 1 ]; then
    printf 'Failed to find targets\\n' >&2
    printf 'This utility formats all bin and lib files of the current crate using rustfmt.\\n' >&2
    exit 1
  fi
fi
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

test("cargo-fmt.sh collapses workspace members to a single workspace-root check", () => {
	const context = makeTempRepo("cargo-fmt-workspace-root-");
	const cargoManifestLog = path.join(context.tempDir, "cargo-manifests.log");

	createCargoStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["crates/member"]
resolver = "2"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					CARGO_MANIFEST_LOG: cargoManifestLog,
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(cargoManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml"],
		);
		assert.match(
			result.details,
			/cargo fmt --check --manifest-path Cargo\.toml/,
		);
		assert.doesNotMatch(result.details, /crates\/member\/Cargo\.toml/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh uses --all for virtual workspace roots", () => {
	const context = makeTempRepo("cargo-fmt-virtual-workspace-");
	const cargoManifestLog = path.join(context.tempDir, "cargo-manifests.log");

	createCargoStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[workspace]
members = ["crates/member"]
resolver = "2"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "crates/member/src/lib.rs"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					CARGO_MANIFEST_LOG: cargoManifestLog,
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(cargoManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml"],
		);
		assert.match(
			result.details,
			/cargo fmt --check --all --manifest-path Cargo\.toml/,
		);
		assert.doesNotMatch(
			result.details,
			/Failed to find targets|This utility formats all bin and lib files/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
