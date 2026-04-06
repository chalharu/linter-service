const fs = require("node:fs");
const path = require("node:path");

function resolveLinterServicePath({ configPath, linterServicePath } = {}) {
	if (typeof linterServicePath === "string" && linterServicePath.length > 0) {
		return path.resolve(linterServicePath);
	}

	if (typeof configPath === "string" && configPath.length > 0) {
		return path.resolve(path.dirname(configPath));
	}

	return path.resolve(__dirname, "../../..");
}

function resolveLinterHookPath({
	configPath,
	fileName,
	linterName,
	linterServicePath,
}) {
	if (typeof fileName !== "string" || fileName.length === 0) {
		throw new Error("fileName is required");
	}

	if (typeof linterName !== "string" || linterName.length === 0) {
		throw new Error("linterName is required");
	}

	return path.join(
		resolveLinterServicePath({ configPath, linterServicePath }),
		linterName,
		fileName,
	);
}

function loadLinterHook(options) {
	const modulePath = resolveLinterHookPath(options);

	if (!fs.existsSync(modulePath)) {
		return null;
	}

	return require(modulePath);
}

module.exports = {
	loadLinterHook,
	resolveLinterHookPath,
	resolveLinterServicePath,
};
