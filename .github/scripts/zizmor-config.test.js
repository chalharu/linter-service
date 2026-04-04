const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const yaml = require("js-yaml");

const repoRoot = path.join(__dirname, "..", "..");

function collectSecretIgnoreEntries(workflowPath) {
	return fs
		.readFileSync(workflowPath, "utf8")
		.split(/\r?\n/u)
		.flatMap((line, index) =>
			/\$\{\{\s*secrets\.(?:CHECKER_APP_ID|CHECKER_PRIVATE_KEY)\s*\}\}/u.test(
				line,
			)
				? [`${path.basename(workflowPath)}:${index + 1}`]
				: [],
		);
}

test("zizmor keeps secrets-outside-env ignores aligned with intentional secret sites", () => {
	const config = yaml.load(
		fs.readFileSync(path.join(repoRoot, ".github", "zizmor.yml"), "utf8"),
		{
			schema: yaml.JSON_SCHEMA,
		},
	);
	const expectedIgnores = [
		path.join(repoRoot, ".github", "workflows", "lint-common.yml"),
		path.join(repoRoot, ".github", "workflows", "repository-dispatch.yml"),
	].flatMap(collectSecretIgnoreEntries);

	assert.deepEqual(
		config?.rules?.["secrets-outside-env"]?.ignore,
		expectedIgnores,
	);
});
