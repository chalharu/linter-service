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

function hasValidHelmLookupInputs({ filePath, repositoryPath }) {
	return (
		typeof filePath === "string" &&
		filePath.trim().length > 0 &&
		typeof repositoryPath === "string" &&
		repositoryPath.length > 0
	);
}

function normalizeHelmSearchDirectory(filePath) {
	const currentDir = path.dirname(normalizeRelativePath(filePath));

	return currentDir.length === 0 ? "." : currentDir;
}

function resolveChartCandidatePath(currentDir, resolvedRepositoryPath) {
	const candidatePath =
		currentDir === "." ? "Chart.yaml" : path.join(currentDir, "Chart.yaml");

	return path.resolve(resolvedRepositoryPath, candidatePath);
}

function isRepositoryRelativePath(relativePath) {
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
}

function hasHelmChartFile({ currentDir, resolvedRepositoryPath }) {
	const resolvedCandidatePath = resolveChartCandidatePath(
		currentDir,
		resolvedRepositoryPath,
	);
	const relativeCandidatePath = path.relative(
		resolvedRepositoryPath,
		resolvedCandidatePath,
	);

	return (
		isRepositoryRelativePath(relativeCandidatePath) &&
		fs.existsSync(resolvedCandidatePath)
	);
}

function getNextSearchDirectory(currentDir) {
	if (currentDir === "." || currentDir === "/" || currentDir === "") {
		return null;
	}

	const nextDir = path.dirname(currentDir);

	return nextDir === currentDir ? null : nextDir;
}

function normalizeChartRoot(currentDir) {
	return currentDir === "." ? "." : normalizeRelativePath(currentDir);
}

function findHelmChartRoot({ filePath, repositoryPath }) {
	if (!hasValidHelmLookupInputs({ filePath, repositoryPath })) {
		return null;
	}

	const resolvedRepositoryPath = path.resolve(repositoryPath);
	let currentDir = normalizeHelmSearchDirectory(filePath);

	while (currentDir !== null) {
		if (hasHelmChartFile({ currentDir, resolvedRepositoryPath })) {
			return normalizeChartRoot(currentDir);
		}

		currentDir = getNextSearchDirectory(currentDir);
	}

	return null;
}

module.exports = {
	filterSelectedFiles,
	findHelmChartRoot,
};
