const {
	getLinterConfig,
} = require("../.github/scripts/linter-service-config.js");

function filterSelectedFiles({ selectedFiles, serviceConfig }) {
	const presetPackages = getLinterConfig(
		serviceConfig,
		"textlint",
	).preset_packages;

	return Array.isArray(presetPackages) && presetPackages.length > 0
		? selectedFiles
		: [];
}

module.exports = {
	filterSelectedFiles,
};
