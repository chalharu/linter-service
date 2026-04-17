function parseJsonLines(text) {
	const items = [];
	const rawLines = [];

	for (const rawLine of String(text || "").split(/\r?\n/u)) {
		const line = rawLine.trim();

		if (line.length === 0) {
			continue;
		}

		try {
			items.push(JSON.parse(line));
		} catch {
			rawLines.push(rawLine);
		}
	}

	return { items, rawLines };
}

module.exports = {
	parseJsonLines,
};
