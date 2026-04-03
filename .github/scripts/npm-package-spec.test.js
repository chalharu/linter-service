const assert = require("node:assert/strict");
const test = require("node:test");

const { parseExactPackageSpec } = require("./npm-package-spec.js");

test("parseExactPackageSpec accepts exact scoped and unscoped package specs", () => {
	assert.deepEqual(
		parseExactPackageSpec("textlint-rule-preset-ja-technical-writing@12.0.2"),
		{
			name: "textlint-rule-preset-ja-technical-writing",
			spec: "textlint-rule-preset-ja-technical-writing@12.0.2",
			version: "12.0.2",
		},
	);
	assert.deepEqual(parseExactPackageSpec("@scope/preset@1.2.3-beta.1"), {
		name: "@scope/preset",
		spec: "@scope/preset@1.2.3-beta.1",
		version: "1.2.3-beta.1",
	});
});

test("parseExactPackageSpec rejects missing versions and ranges", () => {
	assert.throws(
		() => parseExactPackageSpec("textlint-rule-preset-ja-technical-writing"),
		/include an exact version/u,
	);
	assert.throws(
		() =>
			parseExactPackageSpec(
				"textlint-rule-preset-ja-technical-writing@^12.0.2",
			),
		/exact semver version/u,
	);
});
