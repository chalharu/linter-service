const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const scriptPath = path.join(__dirname, "cargo-fmt.sh");

function writeExecutable(filePath, content) {
	fs.writeFileSync(filePath, content, "utf8");
	fs.chmodSync(filePath, 0o755);
}

function createPythonStub(binDir) {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
exit_code="$2"
output_file="$3"
node - "$exit_code" "$output_file" <<'NODE'
const fs = require("node:fs");
const [exitCode, outputFile] = process.argv.slice(2);
const details = fs.existsSync(outputFile)
\t? fs.readFileSync(outputFile, "utf8").trim()
\t: "";
process.stdout.write(JSON.stringify({ details, exit_code: Number(exitCode) }));
NODE
`,
	);
}

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

function makeTempRepo(prefix) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const repoDir = path.join(tempDir, "repo");
	const runnerTemp = path.join(tempDir, "runner");
	const binDir = path.join(tempDir, "bin");
	const cargoManifestLog = path.join(tempDir, "cargo-manifests.log");

	fs.mkdirSync(repoDir, { recursive: true });
	fs.mkdirSync(runnerTemp, { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });

	createPythonStub(binDir);
	createCargoStub(binDir);

	return { binDir, cargoManifestLog, repoDir, runnerTemp, tempDir };
}

function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

test("cargo-fmt.sh groups changed Rust files by nearest Cargo.toml", () => {
	const { binDir, cargoManifestLog, repoDir, runnerTemp, tempDir } =
		makeTempRepo("cargo-fmt-grouped-");

	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(path.join(repoDir, "src/main.rs"), "fn main() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[
				scriptPath,
				"run",
				"src/lib.rs",
				"src/main.rs",
				"crates/member/src/lib.rs",
			],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					CARGO_MANIFEST_LOG: cargoManifestLog,
					PATH: `${binDir}:${process.env.PATH}`,
					RUNNER_TEMP: runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs.readFileSync(cargoManifestLog, "utf8").trim().split("\n"),
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
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-fmt.sh reports Rust files outside Cargo packages", () => {
	const { binDir, cargoManifestLog, repoDir, runnerTemp, tempDir } =
		makeTempRepo("cargo-fmt-missing-manifest-");

	writeFile(path.join(repoDir, "standalone.rs"), "fn main() {}\n");

	try {
		const output = execFileSync("bash", [scriptPath, "run", "standalone.rs"], {
			cwd: repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				CARGO_MANIFEST_LOG: cargoManifestLog,
				PATH: `${binDir}:${process.env.PATH}`,
				RUNNER_TEMP: runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(result.details, /standalone\.rs/);
		assert.equal(fs.existsSync(cargoManifestLog), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-fmt.sh handles absolute Rust file paths outside Cargo packages", () => {
	const { binDir, cargoManifestLog, repoDir, runnerTemp, tempDir } =
		makeTempRepo("cargo-fmt-absolute-missing-manifest-");
	const standalonePath = path.join(tempDir, "standalone.rs");

	writeFile(standalonePath, "fn main() {}\n");

	try {
		const output = execFileSync("bash", [scriptPath, "run", standalonePath], {
			cwd: repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				CARGO_MANIFEST_LOG: cargoManifestLog,
				PATH: `${binDir}:${process.env.PATH}`,
				RUNNER_TEMP: runnerTemp,
			},
			timeout: 1000,
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(result.details, /standalone\.rs/);
		assert.equal(fs.existsSync(cargoManifestLog), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("cargo-fmt.sh continues checking later Cargo packages after one failure", () => {
	const { binDir, cargoManifestLog, repoDir, runnerTemp, tempDir } =
		makeTempRepo("cargo-fmt-continue-");

	writeFile(
		path.join(repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					CARGO_MANIFEST_LOG: cargoManifestLog,
					FAIL_MANIFEST: "Cargo.toml",
					PATH: `${binDir}:${process.env.PATH}`,
					RUNNER_TEMP: runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.deepEqual(
			fs.readFileSync(cargoManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(result.details, /unformatted Cargo\.toml/);
		assert.match(
			result.details,
			/cargo fmt --check --manifest-path crates\/member\/Cargo\.toml/,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
