const test = require("node:test");
const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("./cargo-linter-test-lib");

const { execFileSync } = require("node:child_process");

const scriptPath = path.join(__dirname, "cargo-fmt.sh");

function createRustfmtStub(binDir) {
	writeExecutable(
		path.join(binDir, "rustfmt"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "rustfmt 0.0.0"
  exit 0
fi
files=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      shift
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done
printf '%s\\n' "\${files[*]}" >> "$RUSTFMT_ARGS_LOG"
for file in "\${files[@]}"; do
  if [ -n "\${FAIL_FILE:-}" ] && [ "$file" = "$FAIL_FILE" ]; then
    printf 'Diff in %s at line 1:\\n' "$file"
    printf '%s\\n' '--- original' '+++ formatted'
    exit 1
  fi
done
`,
	);
}

function runCargoFmt(context, args, extraEnv = {}) {
	return JSON.parse(
		execFileSync("bash", [scriptPath, "run", ...args], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...extraEnv,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		}),
	);
}

test("cargo-fmt.sh runs rustfmt directly for selected Rust files", () => {
	const context = makeTempRepo("cargo-fmt-direct-files-");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createRustfmtStub(context.binDir);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(path.join(context.repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const result = runCargoFmt(
			context,
			["src/lib.rs", "src/main.rs", "crates/member/src/lib.rs"],
			{
				RUSTFMT_ARGS_LOG: rustfmtArgsLog,
			},
		);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["src/lib.rs", "src/main.rs", "crates/member/src/lib.rs"],
		);
		assert.match(result.details, /rustfmt --check src\/lib\.rs/);
		assert.match(result.details, /rustfmt --check src\/main\.rs/);
		assert.match(
			result.details,
			/rustfmt --check crates\/member\/src\/lib\.rs/,
		);
		assert.doesNotMatch(result.details, /Cargo\.toml|cargo metadata|--edition/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh formats standalone Rust files without Cargo.toml discovery", () => {
	const context = makeTempRepo("cargo-fmt-standalone-file-");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createRustfmtStub(context.binDir);
	writeFile(path.join(context.repoDir, "standalone.rs"), "fn main() {}\n");

	try {
		const result = runCargoFmt(context, ["standalone.rs"], {
			RUSTFMT_ARGS_LOG: rustfmtArgsLog,
		});

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["standalone.rs"],
		);
		assert.match(result.details, /rustfmt --check standalone\.rs/);
		assert.doesNotMatch(result.details, /Cargo\.toml|cargo metadata|--edition/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh handles absolute Rust file paths directly", () => {
	const context = makeTempRepo("cargo-fmt-absolute-file-");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");
	const standalonePath = path.join(context.tempDir, "standalone.rs");

	createRustfmtStub(context.binDir);
	writeFile(standalonePath, "fn main() {}\n");

	try {
		const result = runCargoFmt(context, [standalonePath], {
			RUSTFMT_ARGS_LOG: rustfmtArgsLog,
		});

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			[standalonePath],
		);
		assert.match(
			result.details,
			new RegExp(standalonePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.doesNotMatch(result.details, /Cargo\.toml|cargo metadata|--edition/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh continues checking later Rust files after one failure", () => {
	const context = makeTempRepo("cargo-fmt-continue-files-");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createRustfmtStub(context.binDir);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const result = runCargoFmt(
			context,
			["src/lib.rs", "crates/member/src/lib.rs"],
			{
				FAIL_FILE: "src/lib.rs",
				RUSTFMT_ARGS_LOG: rustfmtArgsLog,
			},
		);

		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["src/lib.rs", "crates/member/src/lib.rs"],
		);
		assert.match(result.details, /Diff in src\/lib\.rs at line 1:/);
		assert.match(
			result.details,
			/rustfmt --check crates\/member\/src\/lib\.rs/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-fmt.sh skips duplicate Rust file paths", () => {
	const context = makeTempRepo("cargo-fmt-deduplicate-files-");
	const rustfmtArgsLog = path.join(context.tempDir, "rustfmt-args.log");

	createRustfmtStub(context.binDir);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const result = runCargoFmt(
			context,
			["src/lib.rs", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				RUSTFMT_ARGS_LOG: rustfmtArgsLog,
			},
		);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(rustfmtArgsLog, "utf8").trim().split("\n"),
			["src/lib.rs", "crates/member/src/lib.rs"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
