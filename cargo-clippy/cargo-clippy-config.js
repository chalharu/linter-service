const {
	normalizeAptPackages,
} = require("../.github/scripts/cargo-apt-packages.js");

function normalizeCargoClippyConfig({ currentConfig = {}, label = "linters.cargo-clippy" } = {}) {
	if (
		!currentConfig ||
		typeof currentConfig !== "object" ||
		Array.isArray(currentConfig)
	) {
		throw new Error(`${label} must be an object`);
	}

	return {
		apt_packages: normalizeAptPackages({ currentConfig, label }),
	};
}

module.exports = {
	normalizeCargoClippyConfig,
};
