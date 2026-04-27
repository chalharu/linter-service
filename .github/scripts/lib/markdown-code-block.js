function buildTextCodeBlock(text) {
	const normalizedText = typeof text === "string" ? text : "";
	const fence = "`".repeat(longestBacktickRun(normalizedText) + 1);
	return [`${fence}text`, normalizedText, fence];
}

function longestBacktickRun(text) {
	let longest = 2;
	let current = 0;

	for (const character of text) {
		if (character === "`") {
			current += 1;
			longest = Math.max(longest, current);
			continue;
		}

		current = 0;
	}

	return longest;
}

module.exports = {
	buildTextCodeBlock,
};
