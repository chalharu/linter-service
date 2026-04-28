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
		"${{ steps.collect.outputs.publish-results }}",
	);
	assert.equal(detectTargets.outputs["skip-reason"], undefined);
	assert.equal(
		publishResults.if,
		"${{ always() && needs.detect-targets.outputs.publish-results == 'true' }}",
	);
	assert.doesNotMatch(
		publishResults.if,
		/skip-reason/u,
		"skip-reason may be omitted from job outputs when GitHub masks it as a possible secret",
	);
});
