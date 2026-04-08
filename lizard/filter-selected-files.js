const {
	getLinterConfig,
} = require("../.github/scripts/linter-service-config.js");
const { filterFilesByLanguages } = require("./language-config.js");

function filterSelectedFiles({ selectedFiles, serviceConfig }) {
	return filterFilesByLanguages(
		selectedFiles,
		getLinterConfig(serviceConfig, "lizard").languages,
	);
}

module.exports = {
	filterSelectedFiles,
};
