const crypto = require("node:crypto");

const MAX_APT_PACKAGES = 20;
const MAX_APT_PACKAGE_LENGTH = 64;
const APT_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.\-]*$/;

function normalizeAptPackages({ currentConfig, label }) {
	const value = currentConfig?.apt_packages;

	if (value === undefined) {
		return [];
	}

	if (!Array.isArray(value)) {
		throw new Error(`${label}.apt_packages must be an array`);
	}

	if (value.length > MAX_APT_PACKAGES) {
		throw new Error(
			`${label}.apt_packages must contain at most ${MAX_APT_PACKAGES} packages`,
		);
	}

	const seen = new Set();
	const normalized = [];

	for (let index = 0; index < value.length; index += 1) {
		const itemLabel = `${label}.apt_packages[${index}]`;
		const entry = value[index];

		if (typeof entry !== "string") {
			throw new Error(`${itemLabel} must be a string`);
		}

		const name = entry.trim();

		if (name.length === 0) {
			throw new Error(`${itemLabel} must be a non-empty string`);
		}

		if (name.length > MAX_APT_PACKAGE_LENGTH) {
			throw new Error(
				`${itemLabel} must be at most ${MAX_APT_PACKAGE_LENGTH} characters`,
			);
		}

		if (!APT_PACKAGE_PATTERN.test(name)) {
			throw new Error(
				`${itemLabel} must match ${APT_PACKAGE_PATTERN} ` +
					`(Ubuntu official package names only, no version pinning or shell metacharacters)`,
			);
		}

		if (seen.has(name)) {
			throw new Error(`${itemLabel} duplicates package '${name}'`);
		}

		seen.add(name);
		normalized.push(name);
	}

	return normalized;
}

function aptPackagesHash(packages) {
	const sorted = [...packages].sort();
	return crypto
		.createHash("sha256")
		.update(sorted.join("\n"))
		.digest("hex")
		.slice(0, 12);
}

function resolveAptImageRef(baseRef, packages) {
	if (!Array.isArray(packages) || packages.length === 0) {
		return baseRef;
	}

	return `${baseRef}-apt-${aptPackagesHash(packages)}`;
}

module.exports = {
	APT_PACKAGE_PATTERN,
	MAX_APT_PACKAGES,
	MAX_APT_PACKAGE_LENGTH,
	aptPackagesHash,
	normalizeAptPackages,
	resolveAptImageRef,
};
