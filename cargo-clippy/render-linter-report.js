const fs = require("node:fs");
const path = require("node:path");

function collectProjectTargets({ selectedFiles, sourceRepositoryPath }) {
	const manifests = [];
	const seen = new Set();

	for (const selectedFile of selectedFiles) {
		const manifestPath = findNearestCargoManifest(
			sourceRepositoryPath,
			selectedFile,
		);

		if (manifestPath && !seen.has(manifestPath)) {
			seen.add(manifestPath);
			manifests.push(manifestPath);
		}
	}

	return manifests;
}

function findNearestCargoManifest(sourceRepositoryPath, filePath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	let currentDir = path.resolve(repoRoot, path.dirname(filePath));

	if (!isWithinRoot(repoRoot, currentDir)) {
		return null;
	}

	while (isWithinRoot(repoRoot, currentDir)) {
		const candidate = path.join(currentDir, "Cargo.toml");

		if (fs.existsSync(candidate)) {
			return normalizePath(path.relative(repoRoot, candidate) || "Cargo.toml");
		}

		if (currentDir === repoRoot) {
			return null;
		}

		const parentDir = path.dirname(currentDir);

		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}

	return null;
}

function isWithinRoot(rootPath, candidatePath) {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function normalizePath(filePath) {
	return filePath.replace(/\\/gu, "/");
}

module.exports = {
	collectProjectTargets,
};
