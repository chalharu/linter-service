const { normalizeLanguages } = require("./language-config.js");

function normalizeConfig({ currentConfig, entry, label }) {
	const languages = normalizeLanguages({
		label: `${label}.languages`,
		languages: currentConfig.languages,
	});

	if (currentConfig.disabled === false && languages.length === 0) {
		throw new Error(`${label}.languages is required when lizard is enabled`);
	}

	return {
		...entry,
		languages,
	};
}

module.exports = {
	normalizeConfig,
};
