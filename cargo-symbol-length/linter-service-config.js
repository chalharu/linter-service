const {
	normalizeCargoSymbolLengthConfig,
} = require("./cargo-symbol-length-config.js");

function normalizeConfig({ currentConfig, entry, label }) {
	return {
		...entry,
		...normalizeCargoSymbolLengthConfig({ currentConfig, label }),
	};
}

module.exports = {
	normalizeConfig,
};
