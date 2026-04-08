const CONFIG_TRIGGER_PATTERNS = Object.freeze([
	/^\.github\/linter-service\.(?:json|ya?ml)$/u,
	/^whitelizard\.txt$/u,
]);

const LANGUAGE_PATTERNS = Object.freeze({
	cpp: ["\\.(?:c|cc|cpp|cxx|h|hpp)$"],
	csharp: ["\\.cs$"],
	erlang: ["\\.(?:erl|es|escript|hrl)$"],
	fortran: ["\\.(?:f|f03|f08|f70|f90|f95|for|ftn|fpp)$"],
	gdscript: ["\\.gd$"],
	go: ["\\.go$"],
	java: ["\\.java$"],
	javascript: ["\\.(?:cjs|js|jsx|mjs)$"],
	kotlin: ["\\.(?:kt|kts)$"],
	lua: ["\\.lua$"],
	objectivec: ["\\.(?:m|mm)$"],
	perl: ["\\.(?:pl|pm)$"],
	php: ["\\.php$"],
	plsql: ["\\.(?:pkb|pck|pks|plb|pls|sql)$"],
	python: ["\\.py$"],
	r: ["\\.r$"],
	ruby: ["\\.rb$"],
	rust: ["\\.rs$"],
	scala: ["\\.scala$"],
	solidity: ["\\.sol$"],
	st: ["\\.st$"],
	swift: ["\\.swift$"],
	ttcn: ["\\.(?:ttcn|ttcnpp)$"],
	typescript: ["\\.(?:ts|tsx)$"],
	vue: ["\\.vue$"],
	zig: ["\\.zig$"],
});

const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(LANGUAGE_PATTERNS));

function normalizeLanguages({ label, languages }) {
	if (languages === undefined) {
		return [];
	}

	if (!Array.isArray(languages)) {
		throw new Error(`${label} must be an array`);
	}

	if (languages.length === 0) {
		throw new Error(`${label} must not be empty`);
	}

	const normalized = languages.map((language, index) =>
		normalizeLanguage(language, `${label}[${index}]`),
	);
	const seen = new Set();

	for (const language of normalized) {
		if (seen.has(language)) {
			throw new Error(`${label} must not contain duplicate languages`);
		}
		seen.add(language);
	}

	return normalized;
}

function normalizeLanguage(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}

	if (!SUPPORTED_LANGUAGES.includes(value)) {
		throw new Error(
			`${label} must be one of: ${SUPPORTED_LANGUAGES.join(", ")}`,
		);
	}

	return value;
}

function filterFilesByLanguages(filePaths, languages) {
	const normalizedLanguages = Array.isArray(languages) ? languages : [];
	const compiledPatterns = normalizedLanguages.flatMap((language) =>
		getPatternStringsForLanguage(language).map(
			(patternString) => new RegExp(patternString, "iu"),
		),
	);

	return filePaths.filter((filePath) => {
		const normalizedPath = normalizePath(filePath);

		return (
			isConfigTriggerPath(normalizedPath) ||
			compiledPatterns.some((pattern) => pattern.test(normalizedPath))
		);
	});
}

function getAllPatternStrings() {
	return [...new Set(Object.values(LANGUAGE_PATTERNS).flat())];
}

function getPatternStringsForLanguage(language) {
	const patterns = LANGUAGE_PATTERNS[language];

	if (!Array.isArray(patterns)) {
		throw new Error(`unsupported lizard language: ${language}`);
	}

	return patterns;
}

function isConfigTriggerPath(filePath) {
	const normalizedPath = normalizePath(filePath);
	return CONFIG_TRIGGER_PATTERNS.some((pattern) =>
		pattern.test(normalizedPath),
	);
}

function normalizePath(filePath) {
	return String(filePath).replace(/\\/gu, "/").replace(/^\.\//u, "");
}

module.exports = {
	filterFilesByLanguages,
	getAllPatternStrings,
	isConfigTriggerPath,
	normalizeLanguages,
	SUPPORTED_LANGUAGES,
};
