function mergeSarifRuns(documents) {
	const runs = (Array.isArray(documents) ? documents : []).flatMap(
		(document) => (Array.isArray(document?.runs) ? document.runs : []),
	);
	const firstRun = runs.find((run) => run && typeof run === "object");

	if (!firstRun) {
		return {
			$schema: "https://json.schemastore.org/sarif-2.1.0.json",
			runs: [],
			version: "2.1.0",
		};
	}

	const mergedRun = structuredClone(firstRun);
	const seenResults = new Set();
	const rulesById = new Map();

	mergedRun.results = [];
	mergedRun.tool = {
		...(mergedRun.tool && typeof mergedRun.tool === "object"
			? mergedRun.tool
			: {}),
		driver: {
			...(mergedRun?.tool?.driver && typeof mergedRun.tool.driver === "object"
				? mergedRun.tool.driver
				: {}),
			rules: [],
		},
	};

	for (const run of runs) {
		for (const result of Array.isArray(run?.results) ? run.results : []) {
			const key = JSON.stringify(result);
			if (seenResults.has(key)) {
				continue;
			}
			seenResults.add(key);
			mergedRun.results.push(structuredClone(result));
		}

		for (const rule of Array.isArray(run?.tool?.driver?.rules)
			? run.tool.driver.rules
			: []) {
			const key =
				typeof rule?.id === "string" && rule.id.length > 0
					? rule.id
					: JSON.stringify(rule);
			if (rulesById.has(key)) {
				continue;
			}
			rulesById.set(key, structuredClone(rule));
		}
	}

	mergedRun.tool.driver.rules = [...rulesById.values()];

	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		runs: [mergedRun],
		version: "2.1.0",
	};
}

module.exports = {
	mergeSarifRuns,
};
