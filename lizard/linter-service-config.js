const {
	normalizeLanguages,
	normalizeThresholds,
} = require("./language-config.js");

function normalizeConfig({ currentConfig, entry, label }) {
	const languages = normalizeLanguages({
		label: `${label}.languages`,
		languages: currentConfig.languages,
	});
	const thresholds = normalizeThresholds({
		label: `${label}.thresholds`,
		thresholds: currentConfig.thresholds,
	});

	if (currentConfig.disabled === false && languages.length === 0) {
		throw new Error(`${label}.languages is required when lizard is enabled`);
	}

	const missingThresholdLanguages = Object.keys(thresholds).filter(
		(language) => !languages.includes(language),
	);

	if (missingThresholdLanguages.length > 0) {
		throw new Error(
			`${label}.languages must include every language configured in ${label}.thresholds: ${missingThresholdLanguages.join(", ")}`,
		);
	}

	return {
		...entry,
		languages,
		thresholds,
	};
}

module.exports = {
	normalizeConfig,
};
