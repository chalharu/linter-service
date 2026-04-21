function collectFallbackPaths({
	details,
	normalizeReportedPath: normalizePath = (reportedPath) => reportedPath,
	targetPaths,
}) {
	const targetSet = new Set(targetPaths);
	const fallbackPaths = [];

	for (const match of details.matchAll(
		/^Diff in (?<filePath>.+?)(?::\d+| at line \d+):\s*$/gmu,
	)) {
		const filePath = match.groups?.filePath;
		const normalizedPath = filePath ? normalizePath(filePath) : null;
		if (
			!normalizedPath ||
			!targetSet.has(normalizedPath) ||
			fallbackPaths.includes(normalizedPath)
		) {
			continue;
		}

		fallbackPaths.push(normalizedPath);
	}

	return fallbackPaths;
}

module.exports = {
	collectFallbackPaths,
};
