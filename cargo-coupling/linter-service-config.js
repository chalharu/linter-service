const { normalizeCargoCouplingConfig } = require("./cargo-coupling-config.js");

function normalizeConfig({ currentConfig, entry, label }) {
	return {
		...entry,
		...normalizeCargoCouplingConfig({ currentConfig, label }),
	};
}

module.exports = {
	normalizeConfig,
};
