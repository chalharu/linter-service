function collectFallbackPaths({ details, targetPaths }) {
	const targetSet = new Set(targetPaths);
	const fallbackPaths = [];

	for (const match of details.matchAll(
		/^Diff in (?<filePath>.+?)(?::\d+| at line \d+):\s*$/gmu,
	)) {
		const filePath = match.groups?.filePath;
		if (
			!filePath ||
			!targetSet.has(filePath) ||
			fallbackPaths.includes(filePath)
		) {
			continue;
		}

		fallbackPaths.push(filePath);
	}

	return fallbackPaths;
}

module.exports = {
	collectFallbackPaths,
};
