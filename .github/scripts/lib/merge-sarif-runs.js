function collectSarifRuns(documents) {
	const source = Array.isArray(documents) ? documents : [];
	return source.flatMap((document) =>
		Array.isArray(document?.runs) ? document.runs : [],
	);
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object";
}

function createEmptySarifDocument() {
	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		runs: [],
		version: "2.1.0",
	};
}

function createMergedRunSkeleton(firstRun) {
	const mergedRun = structuredClone(firstRun);
	const tool =
		mergedRun.tool && typeof mergedRun.tool === "object"
			? mergedRun.tool
			: {};
	const driver =
		mergedRun?.tool?.driver && typeof mergedRun.tool.driver === "object"
			? mergedRun.tool.driver
			: {};

	mergedRun.results = [];
	mergedRun.tool = {
		...tool,
		driver: {
			...driver,
			rules: [],
		},
	};

	return mergedRun;
}

function collectSarifResults(runs) {
	const seenResults = new Set();
	const results = [];

	for (const run of runs) {
		const entries = Array.isArray(run?.results) ? run.results : [];
		for (const result of entries) {
			const key = JSON.stringify(result);
			if (seenResults.has(key)) {
				continue;
			}
			seenResults.add(key);
			results.push(structuredClone(result));
		}
	}

	return results;
}

function getSarifRuleKey(rule) {
	if (typeof rule?.id === "string" && rule.id.length > 0) {
		return rule.id;
	}

	return JSON.stringify(rule);
}

function collectSarifRules(runs) {
	const rulesById = new Map();

	for (const run of runs) {
		const entries = Array.isArray(run?.tool?.driver?.rules)
			? run.tool.driver.rules
			: [];
		for (const rule of entries) {
			const key = getSarifRuleKey(rule);
			if (rulesById.has(key)) {
				continue;
			}
			rulesById.set(key, structuredClone(rule));
		}
	}

	return [...rulesById.values()];
}

function mergeSarifRuns(documents) {
	const runs = collectSarifRuns(documents);
	const firstRun = runs.find(isRecord);

	if (!firstRun) {
		return createEmptySarifDocument();
	}

	const mergedRun = createMergedRunSkeleton(firstRun);

	mergedRun.results = collectSarifResults(runs);
	mergedRun.tool.driver.rules = collectSarifRules(runs);

	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		runs: [mergedRun],
		version: "2.1.0",
	};
}

module.exports = {
	mergeSarifRuns,
};
