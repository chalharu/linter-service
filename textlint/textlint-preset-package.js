const UNSCOPED_PRESET_PACKAGE = /^textlint-rule-preset-[a-z0-9][a-z0-9._-]*$/u;
const SCOPED_PRESET_PACKAGE =
	/^@[a-z0-9][a-z0-9._-]*\/textlint-rule-preset-[a-z0-9][a-z0-9._-]*$/u;

function getTextlintPresetRuleKey(packageName) {
	if (
		typeof packageName === "string" &&
		UNSCOPED_PRESET_PACKAGE.test(packageName)
	) {
		return packageName.replace(/^textlint-rule-preset-/u, "preset-");
	}

	if (
		typeof packageName === "string" &&
		SCOPED_PRESET_PACKAGE.test(packageName)
	) {
		return packageName.replace(/\/textlint-rule-preset-/u, "/preset-");
	}

	throw new Error(
		`linters.textlint.preset_packages must use textlint preset packages: ${packageName}`,
	);
}

module.exports = {
	getTextlintPresetRuleKey,
};
