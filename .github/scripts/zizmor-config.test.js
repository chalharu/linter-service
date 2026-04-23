const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const yaml = require("js-yaml");

const repoRoot = path.join(__dirname, "..", "..");

test("zizmor allowlists the shared checker secrets for secrets-outside-env", () => {
	const config = yaml.load(
		fs.readFileSync(path.join(repoRoot, ".github", "zizmor.yml"), "utf8"),
		{
			schema: yaml.JSON_SCHEMA,
		},
	);

	assert.deepEqual(config?.rules?.["secrets-outside-env"]?.config?.allow, [
		"CHECKER_APP_ID",
		"CHECKER_PRIVATE_KEY",
	]);
	assert.equal(config?.rules?.["secrets-outside-env"]?.ignore, undefined);
});
