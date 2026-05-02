const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const workflowPath = path.join(
	__dirname,
	"..",
	"workflows",
	"repository-dispatch.yml",
);
const expressionPrefix = "$" + "{{ ";

function readWorkflow() {
	return yaml.load(fs.readFileSync(workflowPath, "utf8"), {
		schema: yaml.JSON_SCHEMA,
	});
}

test("publish-results is gated by a safe boolean output", () => {
	const workflow = readWorkflow();
	const detectTargets = workflow.jobs["detect-targets"];
	const publishResults = workflow.jobs["publish-results"];

	assert.equal(
		detectTargets.outputs["publish-results"],
		`${expressionPrefix}steps.collect.outputs.publish-results }}`,
	);
	assert.equal(detectTargets.outputs["skip-reason"], undefined);
	assert.equal(
		publishResults.if,
		`${expressionPrefix}always() && needs.detect-targets.outputs.publish-results == 'true' }}`,
	);
	assert.doesNotMatch(
		publishResults.if,
		/skip-reason/u,
		"skip-reason may be omitted from job outputs when GitHub masks it as a possible secret",
	);
});

test("PR comment token does not request security-events permission", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const prTokenStep = steps.find((s) => s.id === "get_pr_token");

	assert.ok(prTokenStep, "get_pr_token step must exist");
	assert.equal(
		prTokenStep.with["permission-pull-requests"],
		"write",
		"PR token must request pull-requests: write",
	);
	assert.equal(
		prTokenStep.with["permission-security-events"],
		undefined,
		"PR token must not request security-events permission",
	);
	assert.equal(
		prTokenStep["continue-on-error"],
		undefined,
		"PR token step must not suppress errors",
	);
});

test("SARIF token is a separate step with continue-on-error", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const sarifTokenStep = steps.find((s) => s.id === "get_sarif_token");

	assert.ok(sarifTokenStep, "get_sarif_token step must exist");
	assert.equal(
		sarifTokenStep.if,
		`${expressionPrefix}always() }}`,
		"SARIF token step must run even when earlier publication steps fail",
	);
	assert.equal(
		sarifTokenStep.with["permission-security-events"],
		"write",
		"SARIF token must request security-events: write",
	);
	assert.equal(
		sarifTokenStep.with["permission-pull-requests"],
		undefined,
		"SARIF token must not request pull-requests permission",
	);
	assert.equal(
		sarifTokenStep["continue-on-error"],
		true,
		"SARIF token step must have continue-on-error: true",
	);
});

test("SARIF upload uses SARIF token and only runs when token was obtained", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const uploadStep = steps.find((s) => s.id === "upload_sarif");

	assert.ok(uploadStep, "upload_sarif step must exist");
	assert.match(
		uploadStep.if,
		/steps\.get_sarif_token\.outcome == 'success'/u,
		"upload_sarif must be gated on get_sarif_token outcome",
	);
	assert.match(
		uploadStep.with["github-token"],
		/steps\.get_sarif_token\.outputs\.token/u,
		"upload_sarif must use the SARIF token, not the PR comment token",
	);
	assert.doesNotMatch(
		uploadStep.with["github-token"],
		/get_pr_token/u,
		"upload_sarif must not use the PR comment token",
	);
});

test("PR comment step uses PR token", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const commentStep = steps.find(
		(s) => s.name === "Upsert combined PR comment",
	);

	assert.ok(commentStep, "Upsert combined PR comment step must exist");
	assert.match(
		commentStep.with["github-token"],
		/steps\.get_pr_token\.outputs\.token/u,
		"PR comment step must use the PR token",
	);
	assert.doesNotMatch(
		commentStep.with["github-token"],
		/get_sarif_token/u,
		"PR comment step must not use the SARIF token",
	);
});

test("deselected SARIF failure step also triggers when upload is skipped", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const failStep = steps.find(
		(s) => s.name === "Fail workflow when deselected SARIF upload fails",
	);

	assert.ok(failStep, "deselected SARIF failure step must exist");
	assert.match(
		failStep.if,
		/steps\.upload_sarif\.outcome == 'failure'/u,
		"must still trigger on upload failure",
	);
	assert.match(
		failStep.if,
		/steps\.upload_sarif\.outcome == 'skipped'/u,
		"must also trigger when upload was skipped due to missing token",
	);
	assert.match(
		failStep.run,
		/could not be completed/u,
		"must use wording that also fits skipped uploads",
	);
});

test("deselected SARIF permission skips are diagnosed explicitly", () => {
	const workflow = readWorkflow();
	const steps = workflow.jobs["publish-results"].steps;
	const diagnosticStep = steps.find(
		(s) => s.name === "Diagnose deselected SARIF permission errors",
	);

	assert.ok(
		diagnosticStep,
		"Diagnose deselected SARIF permission errors step must exist",
	);
	assert.match(
		diagnosticStep.if,
		/steps\.upload_sarif\.outcome == 'skipped'/u,
		"diagnostic step must only run when SARIF upload was skipped",
	);
	assert.match(
		diagnosticStep.if,
		/steps\.get_sarif_token\.outcome == 'failure'/u,
		"diagnostic step must point at SARIF token acquisition failures",
	);
	assert.match(
		diagnosticStep.run,
		/::error::/u,
		"diagnostic step must emit a workflow error annotation",
	);
	assert.doesNotMatch(
		diagnosticStep.run,
		/>&2/u,
		"workflow command annotations must be written to stdout",
	);
});
