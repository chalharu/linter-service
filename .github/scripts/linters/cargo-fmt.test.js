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
if [ "\${1-}" = "--version" ]; then
  echo "cargo 0.0.0"
  exit 0
fi
if [ "\${1-}" != "metadata" ]; then
  echo "unexpected cargo command: $*" >&2
  exit 1
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
  printf '%s\\n' "$manifest" >> "$CARGO_METADATA_LOG"
  node - "$manifest" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const manifest = process.argv[2];
const manifestDir = path.dirname(manifest);
const manifestText = fs.readFileSync(manifest, "utf8");
const editionMatch = manifestText.match(/^\\s*edition\\s*=\\s*"([^"]+)"/mu);
const edition = editionMatch ? editionMatch[1] : "2015";
const targetCandidates = ["src/lib.rs", "src/main.rs", "build.rs"];
const targets = [];

for (const candidate of targetCandidates) {
  const relativePath =
    manifestDir === "." ? candidate : path.posix.join(manifestDir, candidate);
  if (fs.existsSync(relativePath)) {
    targets.push({
      src_path: path.resolve(relativePath),
    });
  }
}

process.stdout.write(
  JSON.stringify({
    packages: [
      {
        edition,
        manifest_path: path.resolve(manifest),
        targets,
      },
    ],
  }),
);
NODE
  exit 0
fi
`,
	);
}

function createRustfmtStub(binDir) {
	writeExecutable(
		path.join(binDir, "rustfmt"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "rustfmt 0.0.0"
  exit 0
fi
edition=""
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --edition)
      edition="$2"
      shift 2
      ;;
    --check)
      shift
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done
printf '%s\\t%s\\n' "$edition" "\${files[*]}" >> "$RUSTFMT_ARGS_LOG"
for file in "\${files[@]}"; do
  if [ -n "\${FAIL_FILE:-}" ] && [ "$file" = "$FAIL_FILE" ]; then
    printf 'Diff in %s at line 1:\\n' "$file"
    printf '--- original\\n'
    printf '+++ formatted\\n'
    exit 1
  fi
done
`,
	);
}

defineCommonCargoManifestTests({
	scriptPath,
	tempPrefix: "cargo-fmt-",
	toolName: "cargo-fmt.sh",
	setupTooling(context) {
		const cargoMetadataLog = path.join(context.tempDir, "cargo-metadata.log");
		const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");
		createCargoStub(context.binDir);
		createRustfmtStub(context.binDir);
		return {
			cargoMetadataLog,
			rustfmtArgsLog,
			env: {
				CARGO_METADATA_LOG: cargoMetadataLog,
				RUSTFMT_ARGS_LOG: rustfmtArgsLog,
			},
		};
	},
	assertGroupedResult({ result, tooling }) {
		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(tooling.cargoMetadataLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(
			result.details,
			/rustfmt --check --edition 2021 src\/lib\.rs src\/main\.rs/,
		);
		assert.match(
			result.details,
			/rustfmt --check --edition 2021 crates\/member\/src\/lib\.rs/,
		);
		assert.deepEqual(
			fs.readFileSync(tooling.rustfmtArgsLog, "utf8").trim().split("\n"),
			["2021\tsrc/lib.rs src/main.rs", "2021\tcrates/member/src/lib.rs"],
		);
	},
	assertMissingManifestResult({ pathValue, result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(
			result.details,
			new RegExp(pathValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.equal(fs.existsSync(tooling.cargoMetadataLog), false);
		assert.equal(fs.existsSync(tooling.rustfmtArgsLog), false);
	},
	continueFailureEnv: {
		FAIL_FILE: "src/lib.rs",
	},
	assertContinueAfterFailureResult({ result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(tooling.cargoMetadataLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(result.details, /Diff in src\/lib\.rs at line 1:/);
		assert.match(
			result.details,
			/rustfmt --check --edition 2021 crates\/member\/src\/lib\.rs/,
		);
	},
});

test("cargo-fmt.sh keeps package manifests separate inside package workspaces", () => {
	const context = makeTempRepo("cargo-fmt-package-workspace-");
	const cargoMetadataLog = path.join(context.tempDir, "cargo-metadata.log");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createCargoStub(context.binDir);
	createRustfmtStub(context.binDir);
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
					CARGO_METADATA_LOG: cargoMetadataLog,
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUSTFMT_ARGS_LOG: rustfmtArgsLog,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(cargoMetadataLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["2021\tsrc/lib.rs", "2021\tcrates/member/src/lib.rs"],
		);
		assert.match(result.details, /rustfmt --check --edition 2021 src\/lib\.rs/);
		assert.match(
			result.details,
			/rustfmt --check --edition 2021 crates\/member\/src\/lib\.rs/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh formats virtual workspace members via rustfmt target roots", () => {
	const context = makeTempRepo("cargo-fmt-virtual-workspace-");
	const cargoMetadataLog = path.join(context.tempDir, "cargo-metadata.log");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createCargoStub(context.binDir);
	createRustfmtStub(context.binDir);
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
					CARGO_METADATA_LOG: cargoMetadataLog,
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUSTFMT_ARGS_LOG: rustfmtArgsLog,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(cargoMetadataLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["2021\tcrates/member/src/lib.rs"],
		);
		assert.match(
			result.details,
			/rustfmt --check --edition 2021 crates\/member\/src\/lib\.rs/,
		);
		assert.doesNotMatch(
			result.details,
			/Failed to find targets|cargo fmt --check --all --manifest-path/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
