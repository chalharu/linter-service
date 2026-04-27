const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCargoClippyResult } = require("./cargo-clippy-result.js");

test("buildCargoClippyResult preserves details and extracts structured diagnostics", () => {
	const result = buildCargoClippyResult({
		detailsText: "==> docker run cargo fetch --manifest-path Cargo.toml",
		entriesDir: "/unused",
		exitCode: 1,
		runs: [
			{
				command:
					"docker run cargo clippy --manifest-path Cargo.toml --all-targets -- -D warnings",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr:
					"error: could not compile `demo` (lib) due to 1 previous error\n",
				stdout: JSON.stringify({
					reason: "compiler-message",
					manifest_path: "/work/Cargo.toml",
					package_id: "path+file:///work#demo",
					target: {
						kind: ["lib"],
						name: "demo",
						src_path: "/work/src/lib.rs",
					},
					message: {
						code: {
							code: "clippy::ptr_arg",
							explanation: null,
						},
						children: [],
						level: "error",
						message:
							"writing `&Vec` instead of `&[_]` involves a new object where a slice will do",
						rendered:
							"error: writing `&Vec` instead of `&[_]` involves a new object where a slice will do\n --> /work/src/lib.rs:1:24\n",
						spans: [
							{
								column_start: 24,
								file_name: "/work/src/lib.rs",
								is_primary: true,
								line_start: 1,
							},
						],
					},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_clippy_runs.length, 1);
	assert.equal(result.cargo_clippy_runs[0].manifest_path, "Cargo.toml");
	assert.equal(result.cargo_clippy_runs[0].diagnostics.length, 1);
	assert.equal(
		result.cargo_clippy_runs[0].diagnostics[0].message.spans[0].file_name,
		"src/lib.rs",
	);
	assert.match(
		result.details,
		/==> docker run cargo fetch --manifest-path Cargo\.toml/,
	);
	assert.match(
		result.details,
		/==> docker run cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
	);
	assert.match(
		result.details,
		/error: writing `&Vec` instead of `&\[_\]` involves a new object where a slice will do/,
	);
	assert.match(result.details, /--> src\/lib\.rs:1:24/);
	assert.match(result.details, /could not compile `demo` \(lib\)/);
});

test("buildCargoClippyResult omits structured runs when no compiler diagnostics were emitted", () => {
	const result = buildCargoClippyResult({
		detailsText: "",
		entriesDir: "/unused",
		exitCode: 0,
		runs: [
			{
				command:
					"docker run cargo clippy --manifest-path Cargo.toml --all-targets -- -D warnings",
				exit_code: 0,
				manifest_path: "Cargo.toml",
				stderr:
					"    Finished `dev` profile [unoptimized + debuginfo] target(s)\n",
				stdout: JSON.stringify({
					reason: "build-finished",
					success: true,
				}),
			},
		],
	});

	assert.equal(result.exit_code, 0);
	assert.equal("cargo_clippy_runs" in result, false);
	assert.match(
		result.details,
		/==> docker run cargo clippy --manifest-path Cargo\.toml --all-targets -- -D warnings/,
	);
	assert.doesNotMatch(result.details, /Finished `dev` profile/);
});

test("buildCargoClippyResult dedupes repeated compiler diagnostics", () => {
	const rendered =
		"error: writing `&Vec` instead of `&[_]` involves a new object where a slice will do\n --> /work/src/lib.rs:1:24\n";
	const compilerMessage = {
		reason: "compiler-message",
		manifest_path: "/work/Cargo.toml",
		package_id: "path+file:///work#demo",
		target: {
			kind: ["lib"],
			name: "demo",
			src_path: "/work/src/lib.rs",
		},
		message: {
			code: {
				code: "clippy::ptr_arg",
				explanation: null,
			},
			children: [],
			level: "error",
			message:
				"writing `&Vec` instead of `&[_]` involves a new object where a slice will do",
			rendered,
			spans: [
				{
					column_start: 24,
					file_name: "/work/src/lib.rs",
					is_primary: true,
					line_start: 1,
				},
			],
		},
	};
	const result = buildCargoClippyResult({
		detailsText: "",
		entriesDir: "/unused",
		exitCode: 1,
		runs: [
			{
				command:
					"docker run cargo clippy --manifest-path Cargo.toml --all-targets -- -D warnings",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr:
					"error: could not compile `demo` (lib) due to 1 previous error\n",
				stdout: `${JSON.stringify(compilerMessage)}\n${JSON.stringify(
					compilerMessage,
				)}`,
			},
		],
	});

	assert.equal(result.cargo_clippy_runs[0].diagnostics.length, 1);
	assert.equal(
		result.details.match(
			/error: writing `&Vec` instead of `&\[_\]` involves a new object where a slice will do/g,
		)?.length,
		1,
	);
});
