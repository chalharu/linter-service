const {
	parseExactPackageSpec,
} = require("../.github/scripts/npm-package-spec.js");
const { getTextlintPresetRuleKey } = require("./textlint-preset-package.js");

function normalizeConfig({ currentConfig, entry, label }) {
	if (currentConfig.preset_package !== undefined) {
		throw new Error(
			`${label}.preset_package is no longer supported; use ${label}.preset_packages`,
		);
	}

	const presetPackages = normalizeTextlintPresetPackages({
		label,
		presetPackages: currentConfig.preset_packages,
	});
	const normalized = {
		...entry,
		preset_packages: presetPackages,
	};

	if (currentConfig.disabled === false && presetPackages.length === 0) {
		throw new Error(
			`${label}.preset_packages is required when textlint is enabled`,
		);
	}

	return normalized;
}

function normalizeTextlintPresetPackages({ label, presetPackages }) {
	if (presetPackages === undefined) {
		return [];
	}

	if (!Array.isArray(presetPackages)) {
		throw new Error(`${label}.preset_packages must be an array`);
	}

	if (presetPackages.length === 0) {
		throw new Error(`${label}.preset_packages must not be empty`);
	}

	const normalized = presetPackages.map((entry, index) =>
		normalizeExactPackageSpec(entry, `${label}.preset_packages[${index}]`),
	);
	const seenNames = new Set();

	for (const spec of normalized) {
		const { name } = parseExactPackageSpec(spec, `${label}.preset_packages`);
		getTextlintPresetRuleKey(name);
		if (seenNames.has(name)) {
			throw new Error(
				`${label}.preset_packages must not contain duplicate package names`,
			);
		}
		seenNames.add(name);
	}

	return normalized;
}

function normalizeExactPackageSpec(value, label) {
	const { spec } = parseExactPackageSpec(value, label);
	return spec;
}

module.exports = {
	normalizeConfig,
};
