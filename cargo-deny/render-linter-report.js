const fs = require("node:fs");
const path = require("node:path");

const CARGO_DENY_CONFIG_FILE = /(?:^|\/)\.cargo\/config(?:\.toml)?$/u;
const CARGO_DENY_POLICY_FILE = /(?:^|\/)deny\.toml$/u;

function collectProjectTargets({ selectedFiles, sourceRepositoryPath }) {
	const allManifests = listCargoManifests(sourceRepositoryPath);
	const manifests = [];
	const seen = new Set();

	for (const selectedFile of selectedFiles.map((filePath) =>
		normalizePath(filePath),
	)) {
		let matchingManifests = [];

		if (CARGO_DENY_POLICY_FILE.test(selectedFile)) {
			matchingManifests = allManifests.filter(
				(manifestPath) =>
					findCargoDenyConfig(sourceRepositoryPath, manifestPath) ===
					selectedFile,
			);
		} else if (CARGO_DENY_CONFIG_FILE.test(selectedFile)) {
			matchingManifests = allManifests.filter((manifestPath) =>
				manifestUsesCargoConfig(manifestPath, selectedFile),
			);
		} else {
			const manifestPath = findNearestCargoManifest(
				sourceRepositoryPath,
				selectedFile,
			);

			if (manifestPath) {
				matchingManifests = [manifestPath];
			}
		}

		for (const manifestPath of matchingManifests) {
			if (!seen.has(manifestPath)) {
				seen.add(manifestPath);
				manifests.push(manifestPath);
			}
		}
	}

	return manifests;
}

function listCargoManifests(sourceRepositoryPath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	const manifests = [];
	const pendingDirs = [repoRoot];

	while (pendingDirs.length > 0) {
		const currentDir = pendingDirs.pop();
		const entries = fs.readdirSync(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name === ".git") {
				continue;
			}

			const entryPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				pendingDirs.push(entryPath);
				continue;
			}

			if (entry.isFile() && entry.name === "Cargo.toml") {
				manifests.push(
					normalizePath(path.relative(repoRoot, entryPath) || "Cargo.toml"),
				);
			}
		}
	}

	return manifests.sort();
}

function findCargoDenyConfig(sourceRepositoryPath, manifestPath) {
	const repoRoot = path.resolve(sourceRepositoryPath);
	let currentDir = normalizePath(
		path.posix.dirname(normalizePath(manifestPath)),
	);

	while (true) {
		const candidate =
			currentDir === "." ? "deny.toml" : `${currentDir}/deny.toml`;

		if (fs.existsSync(path.join(repoRoot, candidate))) {
			return candidate;
		}

		if (currentDir === ".") {
			return null;
		}

		const parentDir = normalizePath(path.posix.dirname(currentDir));

		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

function manifestUsesCargoConfig(manifestPath, configPath) {
	const manifestDir = normalizePath(
		path.posix.dirname(normalizePath(manifestPath)),
	);
	const scopeDir = normalizePath(
		path.posix.dirname(path.posix.dirname(normalizePath(configPath))),
	);

	return (
		scopeDir === "." ||
		manifestDir === scopeDir ||
		manifestDir.startsWith(`${scopeDir}/`)
	);
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
