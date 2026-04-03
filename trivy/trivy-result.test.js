const test = require("node:test");

const { assert } = require("../.github/scripts/cargo-linter-test-lib.js");
const {
	collectTrivyDiagnostics,
	renderTrivyDetails,
	severityToLinterLevel,
} = require("./trivy-result.js");

test("severityToLinterLevel maps high severities to errors", () => {
	assert.equal(severityToLinterLevel("CRITICAL"), "error");
	assert.equal(severityToLinterLevel("HIGH"), "error");
	assert.equal(severityToLinterLevel("MEDIUM"), "warning");
	assert.equal(severityToLinterLevel("LOW"), "warning");
});

test("collectTrivyDiagnostics normalizes and sorts misconfigurations", () => {
	const diagnostics = collectTrivyDiagnostics({
		Results: [
			{
				Target: "services/api/Containerfile",
				Misconfigurations: [
					{
						ID: "DS-0002",
						Message: "Last USER command in Dockerfile should not be 'root'",
						Severity: "HIGH",
						CauseMetadata: {
							StartLine: 4,
						},
					},
				],
			},
			{
				Target: "Dockerfile",
				Misconfigurations: [
					{
						ID: "DS-0026",
						Message: "Add HEALTHCHECK instruction in your Dockerfile",
						Severity: "LOW",
					},
				],
			},
		],
	});

	assert.deepEqual(diagnostics, [
		{
			column: 1,
			level: "warning",
			line: 1,
			message: "Add HEALTHCHECK instruction in your Dockerfile",
			ruleId: "DS-0026",
			severity: "LOW",
			target: "Dockerfile",
		},
		{
			column: 1,
			level: "error",
			line: 4,
			message: "Last USER command in Dockerfile should not be 'root'",
			ruleId: "DS-0002",
			severity: "HIGH",
			target: "services/api/Containerfile",
		},
	]);
});

test("renderTrivyDetails renders path diagnostics from a Trivy report", () => {
	const details = renderTrivyDetails({
		exitCode: 1,
		report: {
			Results: [
				{
					Target: "Dockerfile",
					Misconfigurations: [
						{
							ID: "DS-0001",
							Message:
								"Specify a tag in the 'FROM' statement for image 'ubuntu'",
							Severity: "MEDIUM",
							CauseMetadata: {
								StartLine: 1,
							},
						},
						{
							ID: "DS-0002",
							Message: "Last USER command in Dockerfile should not be 'root'",
							Severity: "HIGH",
							CauseMetadata: {
								StartLine: 2,
							},
						},
					],
				},
			],
		},
		stderr: "",
	});

	assert.equal(
		details,
		[
			"Dockerfile:1:1: warning DS-0001 (MEDIUM): Specify a tag in the 'FROM' statement for image 'ubuntu'",
			"Dockerfile:2:1: error DS-0002 (HIGH): Last USER command in Dockerfile should not be 'root'",
		].join("\n"),
	);
});

test("renderTrivyDetails falls back to stderr when Trivy fails before reporting", () => {
	const details = renderTrivyDetails({
		exitCode: 1,
		report: null,
		stderr: "FATAL init error",
	});

	assert.equal(details, "FATAL init error");
});

test("renderTrivyDetails is empty for a clean report", () => {
	const details = renderTrivyDetails({
		exitCode: 0,
		report: {
			Results: [
				{
					Target: "Dockerfile",
					MisconfSummary: {
						Failures: 0,
						Successes: 27,
					},
				},
			],
		},
		stderr: "",
	});

	assert.equal(details, "");
});
