const DEFAULT_MAX_SYMBOL_LENGTH = 1024;

function normalizeCargoSymbolLengthConfig({
	currentConfig = {},
	label = "linters.cargo-symbol-length",
} = {}) {
	if (
		!currentConfig ||
		typeof currentConfig !== "object" ||
		Array.isArray(currentConfig)
	) {
		throw new Error(`${label} must be an object`);
	}

	return {
		max_symbol_length: normalizePositiveInteger(
			currentConfig.max_symbol_length,
			`${label}.max_symbol_length`,
			DEFAULT_MAX_SYMBOL_LENGTH,
		),
	};
}

function normalizePositiveInteger(value, label, fallback) {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}

	return value;
}

module.exports = {
	DEFAULT_MAX_SYMBOL_LENGTH,
	normalizeCargoSymbolLengthConfig,
};
