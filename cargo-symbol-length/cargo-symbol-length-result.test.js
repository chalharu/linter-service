const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	buildCargoSymbolLengthResult,
} = require("./cargo-symbol-length-result.js");
const {
	DEFAULT_MAX_SYMBOL_LENGTH,
} = require("./cargo-symbol-length-config.js");

const SHORT_SYMBOL = "short_fn";
const LONG_SYMBOL = "a".repeat(1025);

function makeRun({
	command = "cargo rustc --manifest-path Cargo.toml --lib -- --emit=obj -o /cargo-target/symbol-scan-1.o",
	exit_code = 0,
	manifest_path = "/work/Cargo.toml",
	symbols_raw = "",
	stderr = "",
	stdout = "",
	target_kind = "lib",
	target_name = "mylib",
	target_src_path = "src/lib.rs",
} = {}) {
	return {
		command,
		exit_code,
		manifest_path,
		stderr,
		stdout,
		symbols_raw,
		target_kind,
		target_name,
		target_src_path,
	};
}

test("buildCargoSymbolLengthResult returns exit_code 0 when no symbols exceed threshold", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${SHORT_SYMBOL.length}\t${SHORT_SYMBOL}\n`,
			}),
		],
	});

	assert.equal(result.exit_code, 0);
	assert.equal(result.cargo_symbol_length_runs.length, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 0);
});

test("buildCargoSymbolLengthResult returns exit_code 1 when a symbol meets the threshold", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${LONG_SYMBOL.length}\t${LONG_SYMBOL}\n`,
			}),
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings[0].length, 1025);
	assert.equal(
		result.cargo_symbol_length_runs[0].findings[0].symbol,
		LONG_SYMBOL,
	);
	assert.equal(
		result.cargo_symbol_length_runs[0].findings[0].target_src_path,
		"src/lib.rs",
	);
});

test("buildCargoSymbolLengthResult flags symbols at the exact default threshold", () => {
	const exactSymbol = "x".repeat(DEFAULT_MAX_SYMBOL_LENGTH);

	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${exactSymbol.length}\t${exactSymbol}\n`,
			}),
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 1);
	assert.equal(
		result.cargo_symbol_length_runs[0].findings[0].length,
		DEFAULT_MAX_SYMBOL_LENGTH,
	);
});

test("buildCargoSymbolLengthResult uses custom max_symbol_length threshold", () => {
	const mediumSymbol = "b".repeat(512);

	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: { max_symbol_length: 512 },
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${mediumSymbol.length}\t${mediumSymbol}\n`,
			}),
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings[0].length, 512);
});

test("buildCargoSymbolLengthResult returns exit_code 1 on non-zero commandExitCode even with no findings", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 1,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				exit_code: 1,
				symbols_raw: "",
				stderr: "error[E0308]: mismatched types\n",
			}),
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 0);
});

test("buildCargoSymbolLengthResult normalizes /work/ prefix from manifest_path and command", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				command:
					"cargo rustc --manifest-path /work/Cargo.toml --lib -- --emit=obj",
				manifest_path: "/work/Cargo.toml",
				symbols_raw: "",
			}),
		],
	});

	assert.equal(result.cargo_symbol_length_runs[0].manifest_path, "Cargo.toml");
	assert.equal(
		result.cargo_symbol_length_runs[0].command,
		"cargo rustc --manifest-path Cargo.toml --lib -- --emit=obj",
	);
});

test("buildCargoSymbolLengthResult includes finding details in details string", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${LONG_SYMBOL.length}\t${LONG_SYMBOL}\n`,
				stderr:
					"   Compiling mylib v0.1.0 (/work)\n    Finished `dev` profile\n",
			}),
		],
	});

	assert.match(result.details, /Found 1 symbol\(s\) with length >= 1024/);
	assert.match(result.details, /length: 1025/);
	assert.match(result.details, /Compiling mylib/);
});

test("buildCargoSymbolLengthResult handles multiple runs", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${SHORT_SYMBOL.length}\t${SHORT_SYMBOL}\n`,
				target_name: "lib1",
				target_src_path: "src/lib.rs",
			}),
			makeRun({
				symbols_raw: `${LONG_SYMBOL.length}\t${LONG_SYMBOL}\n`,
				target_name: "bin1",
				target_kind: "bin",
				target_src_path: "src/main.rs",
			}),
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_symbol_length_runs.length, 2);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 0);
	assert.equal(result.cargo_symbol_length_runs[1].findings.length, 1);
});

test("buildCargoSymbolLengthResult ignores symbols shorter than threshold", () => {
	// Default threshold is 1024; a symbol of exactly 1023 chars should NOT be flagged
	const underSymbol = "c".repeat(1023);

	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				symbols_raw: `${underSymbol.length}\t${underSymbol}\n`,
			}),
		],
	});

	assert.equal(result.exit_code, 0);
	assert.equal(result.cargo_symbol_length_runs[0].findings.length, 0);
});

test("buildCargoSymbolLengthResult strips internal state from output runs", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [makeRun({ symbols_raw: "" })],
	});

	const run = result.cargo_symbol_length_runs[0];
	assert.ok(!Object.hasOwn(run, "_stdout"));
	assert.ok(!Object.hasOwn(run, "_stderr"));
	assert.ok(!Object.hasOwn(run, "symbols_raw"));
});

test("buildCargoSymbolLengthResult includes compiler stderr on failed runs", () => {
	const result = buildCargoSymbolLengthResult({
		commandExitCode: 1,
		config: {},
		entriesDir: "/unused",
		runs: [
			makeRun({
				exit_code: 1,
				stderr: "error: could not compile mylib due to previous error\n",
				symbols_raw: "",
			}),
		],
	});

	assert.match(result.details, /could not compile mylib/u);
});

test("buildCargoSymbolLengthResult includes prelude details when command fails before runs", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "cargo-symbol-length-result-"),
	);
	const detailsPath = path.join(tempDir, "output.txt");
	fs.writeFileSync(
		detailsPath,
		"==> docker run cargo fetch --manifest-path Cargo.toml\nfetch failed for Cargo.toml\n",
		"utf8",
	);

	try {
		const result = buildCargoSymbolLengthResult({
			commandExitCode: 1,
			config: {},
			detailsPath,
			entriesDir: "/unused",
			runs: [],
		});

		assert.match(result.details, /fetch failed for Cargo\.toml/u);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
