const fs = require("node:fs");
const path = require("node:path");

const {
	mergeSarifRuns,
} = require("../.github/scripts/lib/merge-sarif-runs.js");

function mergeSarifDirectory(inputDir) {
	const fileNames = fs.existsSync(inputDir)
		? fs
				.readdirSync(inputDir)
				.filter((fileName) => fileName.endsWith(".sarif"))
				.sort()
		: [];

	return mergeSarifRuns(
		fileNames.map((fileName) =>
			JSON.parse(fs.readFileSync(path.join(inputDir, fileName), "utf8")),
		),
	);
}

function runCli(argv = process.argv.slice(2)) {
	const [inputDir, outputPath] = argv;
	const merged = mergeSarifDirectory(inputDir);
	fs.writeFileSync(outputPath, JSON.stringify(merged), "utf8");
}

if (require.main === module) {
	runCli();
}

module.exports = {
	mergeSarifDirectory,
};
