function parseExactPackageSpec(value, label = "package spec") {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}

	const spec = value.trim();
	const separator = spec.lastIndexOf("@");

	if (separator <= 0) {
		throw new Error(`${label} must include an exact version`);
	}

	const name = spec.slice(0, separator);
	const version = spec.slice(separator + 1);

	if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
		throw new Error(`${label} must use a valid npm package name`);
	}

	if (
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
	) {
		throw new Error(`${label} must use an exact semver version`);
	}

	return {
		name,
		spec,
		version,
	};
}

module.exports = {
	parseExactPackageSpec,
};
