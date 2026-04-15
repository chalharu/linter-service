const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCargoDenyResult } = require("./cargo-deny-result.js");

test("buildCargoDenyResult renders advisory and config diagnostics from structured output", () => {
	const result = buildCargoDenyResult({
		exitCode: 1,
		runs: [
			{
				command:
					"cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
				config_path: "deny.toml",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr: [
					JSON.stringify({
						type: "diagnostic",
						fields: {
							code: "rejected",
							labels: [
								{
									column: 9,
									line: 5,
									message: "missing comma",
									span: 'allow = ["MIT" "Apache-2.0"]',
								},
							],
							message: "failed to parse config",
							notes: [],
							severity: "error",
						},
					}),
				].join("\n"),
				stdout: JSON.stringify({
					lockfile: { "dependency-count": 1 },
					settings: {},
					vulnerabilities: [
						{
							advisory: {
								id: "RUSTSEC-2024-0001",
								title: "Critical vulnerability",
							},
							package: {
								name: "demo",
								version: "0.1.0",
							},
						},
					],
					warnings: {},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_deny_runs.length, 1);
	assert.equal(result.cargo_deny_runs[0].audit_reports.length, 1);
	assert.equal(result.cargo_deny_runs[0].diagnostics.length, 1);
	assert.match(
		result.details,
		/==> cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output --config deny\.toml/,
	);
	assert.match(
		result.details,
		/error\[RUSTSEC-2024-0001\]: demo 0\.1\.0 - Critical vulnerability/,
	);
	assert.match(result.details, /error\[rejected\]: failed to parse config/);
	assert.match(result.details, /deny\.toml:5:9: missing comma/);
});

test("buildCargoDenyResult renders warning advisories and diagnostic fallbacks", () => {
	const result = buildCargoDenyResult({
		exitCode: 1,
		runs: [
			{
				command:
					"cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
				config_path: "deny.toml",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr: [
					JSON.stringify({
						type: "diagnostic",
						fields: {
							code: "rejected",
							labels: [
								{
									column: 7,
									line: 3,
									span: 'allow = ["MIT" "Apache-2.0"]',
								},
							],
							message: "",
							notes: ["fix deny.toml"],
							severity: "warning",
						},
					}),
				].join("\n"),
				stdout: JSON.stringify({
					lockfile: { "dependency-count": 1 },
					settings: {},
					vulnerabilities: [],
					warnings: {
						notice: [
							{
								advisory: {
									id: "RUSTSEC-2024-0002",
								},
								package: {
									name: "demo",
									version: "0.2.0",
								},
							},
						],
					},
				}),
			},
		],
	});

	assert.match(
		result.details,
		/warning\[RUSTSEC-2024-0002\]: demo 0\.2\.0 - RUSTSEC-2024-0002/,
	);
	assert.match(
		result.details,
		/warning\[rejected\]: cargo-deny reported an issue/,
	);
	assert.match(
		result.details,
		/deny\.toml:3:7: allow = \["MIT" "Apache-2\.0"\]/,
	);
	assert.match(result.details, /note: fix deny\.toml/);
});

test("buildCargoDenyResult ignores warning-only duplicate diagnostics", () => {
	const result = buildCargoDenyResult({
		exitCode: 1,
		runs: [
			{
				command:
					"cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output",
				config_path: "",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr: [
					JSON.stringify({
						type: "diagnostic",
						fields: {
							code: "duplicate",
							labels: [
								{
									column: 1,
									line: 10,
									message: "lock entries",
									span: [
										"block-buffer 0.10.4 registry+https://github.com/rust-lang/crates.io-index",
										"block-buffer 0.12.0 registry+https://github.com/rust-lang/crates.io-index",
									].join("\n"),
								},
							],
							message: "found 2 duplicate entries for crate 'block-buffer'",
							notes: [],
							severity: "warning",
						},
					}),
					JSON.stringify({
						type: "summary",
						fields: {
							advisories: { errors: 0, helps: 0, notes: 0, warnings: 0 },
							bans: { errors: 0, helps: 0, notes: 0, warnings: 1 },
							licenses: { errors: 0, helps: 0, notes: 0, warnings: 0 },
							sources: { errors: 0, helps: 0, notes: 0, warnings: 0 },
						},
					}),
				].join("\n"),
				stdout: JSON.stringify({
					lockfile: { "dependency-count": 1 },
					settings: {},
					vulnerabilities: {
						count: 0,
						found: false,
						list: [],
					},
					warnings: {},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 0);
	assert.equal(result.warning_count, 1);
	assert.equal(result.cargo_deny_runs.length, 1);
	assert.equal(result.cargo_deny_runs[0].exit_code, 1);
	assert.equal(result.cargo_deny_runs[0].diagnostics.length, 0);
	assert.equal(result.cargo_deny_runs[0].warning_diagnostics.length, 1);
	assert.match(
		result.details,
		/warning\[duplicate\]: found 2 duplicate entries/,
	);
});
