const test = require("node:test");

const { assert } = require("../.github/scripts/cargo-linter-test-lib.js");
const {
	buildShellcheckResult,
	collectShellcheckDiagnostics,
	normalizeRuleId,
} = require("./shellcheck-result.js");

test("normalizeRuleId prefixes numeric shellcheck codes", () => {
	assert.equal(normalizeRuleId(2086), "SC2086");
	assert.equal(normalizeRuleId("1091"), "SC1091");
	assert.equal(normalizeRuleId("SC2154"), "SC2154");
});

test("collectShellcheckDiagnostics maps json1 comments to diagnostics", () => {
	assert.deepEqual(
		collectShellcheckDiagnostics({
			comments: [
				{
					code: 2086,
					column: 6,
					file: "./script.sh",
					level: "info",
					line: 3,
					message: "Double quote to prevent globbing and word splitting.",
				},
			],
		}),
		[
			{
				column: 6,
				file_path: "script.sh",
				help_uri: "https://www.shellcheck.net/wiki/SC2086",
				level: "note",
				line: 3,
				message: "Double quote to prevent globbing and word splitting.",
				rule_id: "SC2086",
			},
		],
	);
});

test("buildShellcheckResult emits embedded sarif when diagnostics exist", () => {
	const result = buildShellcheckResult({
		exitCode: 1,
		report: {
			comments: [
				{
					code: 2086,
					column: 6,
					file: "script.sh",
					level: "info",
					line: 3,
					message: "Double quote to prevent globbing and word splitting.",
				},
			],
		},
		stderr: "",
	});

	assert.equal(result.exit_code, 1);
	assert.equal(result.sarif.runs[0].results[0].ruleId, "SC2086");
	assert.equal(
		result.sarif.runs[0].results[0].locations[0].physicalLocation
			.artifactLocation.uri,
		"script.sh",
	);
});

test("buildShellcheckResult falls back to stderr on pre-report failure", () => {
	const result = buildShellcheckResult({
		exitCode: 2,
		report: null,
		stderr: "shellcheck: unknown option",
	});

	assert.deepEqual(result, {
		details: "shellcheck: unknown option",
		exit_code: 2,
	});
});
