const {
	normalizeCargoClippyConfig,
} = require("./cargo-clippy-config.js");

function normalizeConfig({ currentConfig, entry, label }) {
	return {
		...entry,
		...normalizeCargoClippyConfig({ currentConfig, label }),
	};
}

module.exports = {
	normalizeConfig,
};
