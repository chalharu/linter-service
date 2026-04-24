const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCargoCouplingResult } = require("./cargo-coupling-result.js");

test("buildCargoCouplingResult evaluates default quality gates from JSON output", () => {
	const result = buildCargoCouplingResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			{
				analysis_path: "src",
				command: "docker run cargo-coupling --json --no-git src",
				exit_code: 0,
				manifest_path: "Cargo.toml",
				stderr: "",
				stdout: JSON.stringify({
					circular_dependencies: [["crate::a", "crate::b", "crate::a"]],
					hotspots: [],
					issues: [
						{
							description:
								"Intrusive coupling across a distant module boundary",
							issue_type: "Global Complexity",
							severity: "Critical",
							source: "crate::a",
							suggestion: "Introduce a trait.",
							target: "crate::b",
						},
					],
					modules: [
						{
							file_path: "src/lib.rs",
							name: "crate::a",
						},
					],
					summary: {
						critical_issues: 1,
						health_grade: "C",
						health_score: 0.55,
						high_issues: 0,
						medium_issues: 0,
						total_couplings: 1,
						total_modules: 2,
					},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.cargo_coupling_runs.length, 1);
	assert.deepEqual(result.cargo_coupling_runs[0].check_result.failures, [
		"Grade C is below minimum B",
		"1 critical issues (max: 0)",
		"1 circular dependencies (max: 0)",
	]);
	assert.match(result.details, /Quality gate: FAILED/);
	assert.match(result.details, /Global Complexity/);
	assert.match(result.details, /Circular dependencies:/);
});

test("buildCargoCouplingResult honors repository-configured thresholds", () => {
	const result = buildCargoCouplingResult({
		commandExitCode: 0,
		config: {
			max_circular: 1,
			max_critical: 1,
			min_grade: "C",
		},
		entriesDir: "/unused",
		runs: [
			{
				analysis_path: "src",
				command: "docker run cargo-coupling --json --no-git src",
				exit_code: 0,
				manifest_path: "Cargo.toml",
				stderr: "",
				stdout: JSON.stringify({
					circular_dependencies: [["crate::a", "crate::b", "crate::a"]],
					hotspots: [],
					issues: [],
					modules: [],
					summary: {
						critical_issues: 1,
						health_grade: "C",
						health_score: 0.73,
						high_issues: 0,
						medium_issues: 0,
						total_couplings: 1,
						total_modules: 2,
					},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 0);
	assert.equal(result.cargo_coupling_runs[0].check_result.passed, true);
	assert.match(result.details, /Quality gate: PASSED/);
	assert.match(
		result.details,
		/Thresholds: min_grade=C, max_critical=1, max_circular=1/,
	);
});

test("buildCargoCouplingResult treats grade S as stricter than grade A", () => {
	const result = buildCargoCouplingResult({
		commandExitCode: 0,
		config: {
			min_grade: "S",
		},
		entriesDir: "/unused",
		runs: [
			{
				analysis_path: "src",
				command: "docker run cargo-coupling --json --no-git src",
				exit_code: 0,
				manifest_path: "Cargo.toml",
				stderr: "",
				stdout: JSON.stringify({
					circular_dependencies: [],
					hotspots: [],
					issues: [],
					modules: [],
					summary: {
						critical_issues: 0,
						health_grade: "A",
						health_score: 0.98,
						high_issues: 0,
						medium_issues: 0,
						total_couplings: 1,
						total_modules: 1,
					},
				}),
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.deepEqual(result.cargo_coupling_runs[0].check_result.failures, [
		"Grade A is below minimum S",
	]);
});

test("buildCargoCouplingResult preserves runtime failures without JSON output", () => {
	const result = buildCargoCouplingResult({
		commandExitCode: 1,
		config: {},
		entriesDir: "/unused",
		runs: [
			{
				analysis_path: "src",
				command: "docker run cargo-coupling --json --no-git src",
				exit_code: 1,
				manifest_path: "Cargo.toml",
				stderr: "cargo-coupling failed to analyze the workspace",
				stdout: "",
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.equal("check_result" in result.cargo_coupling_runs[0], false);
	assert.match(result.details, /failed to analyze the workspace/);
});

test("buildCargoCouplingResult fails closed for incomplete cargo-coupling JSON", () => {
	const result = buildCargoCouplingResult({
		commandExitCode: 0,
		config: {},
		entriesDir: "/unused",
		runs: [
			{
				analysis_path: "src",
				command: "docker run cargo-coupling --json --no-git src",
				exit_code: 0,
				manifest_path: "Cargo.toml",
				stderr: "",
				stdout: "{}",
			},
		],
	});

	assert.equal(result.exit_code, 1);
	assert.deepEqual(result.cargo_coupling_runs[0].json_output, {});
	assert.equal("check_result" in result.cargo_coupling_runs[0], false);
	assert.match(result.details, /Invalid cargo-coupling JSON:/u);
	assert.match(result.details, /summary must be an object/u);
});
