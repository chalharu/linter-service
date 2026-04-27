const CARGO_PROGRESS_LINE_PATTERN = /^\s*(?:Checking|Compiling|Finished)\b/u;

function isCargoProgressLine(line) {
	return CARGO_PROGRESS_LINE_PATTERN.test(String(line));
}

function filterCargoProgressLines(lines) {
	return (Array.isArray(lines) ? lines : []).filter(
		(line) => !isCargoProgressLine(line),
	);
}

module.exports = {
	filterCargoProgressLines,
	isCargoProgressLine,
};
