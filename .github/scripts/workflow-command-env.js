const fs = require("node:fs");
const path = require("node:path");

function applyWorkflowEnvironment(baseEnv, { githubEnvPath, githubPathPath }) {
	const nextEnv = { ...baseEnv };

	if (fs.existsSync(githubPathPath)) {
		const pathEntries = fs
			.readFileSync(githubPathPath, "utf8")
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);

		if (pathEntries.length > 0) {
			const basePath =
				typeof baseEnv.PATH === "string" && baseEnv.PATH.length > 0
					? baseEnv.PATH
					: "";
			nextEnv.PATH = [pathEntries.join(path.delimiter), basePath]
				.filter(Boolean)
				.join(path.delimiter);
		}
	}

	if (fs.existsSync(githubEnvPath)) {
		for (const line of fs
			.readFileSync(githubEnvPath, "utf8")
			.split(/\r?\n/u)
			.filter(Boolean)) {
			const separator = line.indexOf("=");

			if (separator <= 0) {
				continue;
			}

			nextEnv[line.slice(0, separator)] = line.slice(separator + 1);
		}
	}

	delete nextEnv.GITHUB_ENV;
	delete nextEnv.GITHUB_PATH;

	return nextEnv;
}

module.exports = {
	applyWorkflowEnvironment,
};
