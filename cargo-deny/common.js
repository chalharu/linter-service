function buildCargoDenyPackageLabel(packageInfo) {
	return [packageInfo?.name, packageInfo?.version].filter(Boolean).join(" ");
}

function normalizeCargoDenyWarnings(warnings) {
	return warnings && typeof warnings === "object" ? warnings : {};
}

function normalizeCargoDenyWarningEntries(entries) {
	return Array.isArray(entries) ? entries : [];
}

function listCargoDenyWarningKinds(warnings) {
	return Object.keys(normalizeCargoDenyWarnings(warnings)).sort();
}

module.exports = {
	buildCargoDenyPackageLabel,
	listCargoDenyWarningKinds,
	normalizeCargoDenyWarningEntries,
	normalizeCargoDenyWarnings,
};
