const fs = require("node:fs");
const path = require("node:path");

const {
	normalizeRelativePath,
} = require("../.github/scripts/linter-service-config.js");

function filterSelectedFiles({ repositoryPath, selectedFiles }) {
	if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
		return selectedFiles;
	}

	return selectedFiles.filter(
		(filePath) =>
			findHelmChartRoot({
				filePath,
				repositoryPath,
			}) !== null,
	);
}

function findHelmChartRoot({ filePath, repositoryPath }) {
	if (
		typeof filePath !== "string" ||
		filePath.trim().length === 0 ||
		typeof repositoryPath !== "string" ||
		repositoryPath.length === 0
	) {
		return null;
	}

	const resolvedRepositoryPath = path.resolve(repositoryPath);
	let currentDir = path.dirname(normalizeRelativePath(filePath));

	if (currentDir.length === 0) {
		currentDir = ".";
	}

	while (true) {
		const candidatePath =
			currentDir === "." ? "Chart.yaml" : path.join(currentDir, "Chart.yaml");
		const resolvedCandidatePath = path.resolve(
			resolvedRepositoryPath,
			candidatePath,
		);
		const relativeCandidatePath = path.relative(
			resolvedRepositoryPath,
			resolvedCandidatePath,
		);

		if (
			relativeCandidatePath !== ".." &&
			!relativeCandidatePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativeCandidatePath) &&
			fs.existsSync(resolvedCandidatePath)
		) {
			return currentDir === "." ? "." : normalizeRelativePath(currentDir);
		}

		if (currentDir === "." || currentDir === "/" || currentDir === "") {
			return null;
		}

		const nextDir = path.dirname(currentDir);
		if (nextDir === currentDir) {
			return null;
		}

		currentDir = nextDir;
	}
}

module.exports = {
	filterSelectedFiles,
	findHelmChartRoot,
};
