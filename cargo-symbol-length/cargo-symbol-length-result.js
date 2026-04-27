const fs = require("node:fs");
const path = require("node:path");
const {
	filterCargoProgressLines,
} = require("../.github/scripts/lib/cargo-progress-lines.js");

const {
	normalizeCargoSymbolLengthConfig,
} = require("./cargo-symbol-length-config.js");

const WORK_ROOT_PREFIX = "/work/";

function readTextFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return "";
	}

	return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath) {
	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function normalizeWorkPath(value) {
	if (typeof value !== "string") {
		return value ?? "";
	}

	// Replace all occurrences of the Docker work-root prefix so paths in
	// command strings and manifest paths are repository-relative.
	return value.split(WORK_ROOT_PREFIX).join("");
}

function readRunEntries(entriesDir) {
	if (!fs.existsSync(entriesDir)) {
		return [];
	}

	return fs
		.readdirSync(entriesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((entryName) => {
			const entryDir = path.join(entriesDir, entryName);
			return {
				command: readTextFile(path.join(entryDir, "command.txt")).trim(),
				exit_code: readTextFile(path.join(entryDir, "exit_code.txt")).trim(),
				manifest_path: readTextFile(
					path.join(entryDir, "manifest_path.txt"),
				).trim(),
				stderr: readTextFile(path.join(entryDir, "stderr.txt")),
				stdout: readTextFile(path.join(entryDir, "stdout.txt")),
				symbols_raw: readTextFile(path.join(entryDir, "symbols.txt")),
				target_kind: readTextFile(
					path.join(entryDir, "target_kind.txt"),
				).trim(),
				target_name: readTextFile(
					path.join(entryDir, "target_name.txt"),
				).trim(),
				target_src_path: readTextFile(
					path.join(entryDir, "target_src_path.txt"),
				).trim(),
			};
		});
}

function parseSymbols(symbolsRaw) {
	if (typeof symbolsRaw !== "string" || symbolsRaw.trim().length === 0) {
		return [];
	}

	return symbolsRaw
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const tabIndex = line.indexOf("\t");
			if (tabIndex === -1) {
				return null;
			}

			const lengthStr = line.slice(0, tabIndex);
			const symbol = line.slice(tabIndex + 1);
			const length = Number.parseInt(lengthStr, 10);

			if (
				!Number.isInteger(length) ||
				length <= 0 ||
				symbol.length === 0 ||
				length !== symbol.length
			) {
				return null;
			}

			return { length, symbol };
		})
		.filter((item) => item !== null);
}

function normalizeRun(run, config) {
	const exitCode = Number.parseInt(String(run?.exit_code || "0"), 10) || 0;
	const command = normalizeWorkPath(String(run?.command || "").trim());
	const manifestPath = normalizeWorkPath(
		String(run?.manifest_path || "").trim(),
	);
	const targetSrcPath = String(run?.target_src_path || "").trim();
	const targetName = String(run?.target_name || "").trim();
	const targetKind = String(run?.target_kind || "").trim();
	const allSymbols = parseSymbols(run?.symbols_raw);
	const { max_symbol_length: maxLen } = config;
	const findings = allSymbols
		.filter((s) => s.length >= maxLen)
		.map((s) => ({
			length: s.length,
			symbol: s.symbol,
			target_src_path: targetSrcPath,
		}));

	return {
		command,
		exit_code: exitCode,
		findings,
		manifest_path: manifestPath,
		target_kind: targetKind,
		target_name: targetName,
		target_src_path: targetSrcPath,
	};
}

function buildDetails(preludeText, runs, config) {
	const { max_symbol_length: maxLen } = config;
	const blocks = [];

	const prelude = typeof preludeText === "string" ? preludeText.trim() : "";
	if (prelude.length > 0) {
		blocks.push(prelude);
	}

	for (const run of runs) {
		const runLines = [];
		const rawLines = [
			...String(run._stdout || "").split(/\r?\n/u),
			...String(run._stderr || "").split(/\r?\n/u),
		]
			.map((line) => line.trimEnd())
			.filter((line) => line.trim().length > 0);
		const trailingLines = filterCargoProgressLines(rawLines);

		if (run.command) {
			runLines.push(`==> ${run.command}`);
		}

		if (run.findings.length > 0) {
			runLines.push(
				`Found ${run.findings.length} symbol(s) with length >= ${maxLen} in ${run.target_src_path || run.manifest_path}:`,
			);
			for (const finding of run.findings) {
				runLines.push(`  ${finding.symbol} (length: ${finding.length})`);
			}
		}

		if (trailingLines.length > 0) {
			runLines.push(trailingLines.join("\n"));
		}

		const block = runLines
			.filter((line) => String(line).trim().length > 0)
			.join("\n");

		if (block.trim().length > 0) {
			blocks.push(block);
		}
	}

	return blocks.join("\n\n").trim();
}

function buildCargoSymbolLengthResult({
	commandExitCode = 0,
	config = {},
	detailsPath = null,
	entriesDir,
	runs = null,
}) {
	const resolvedConfig = normalizeCargoSymbolLengthConfig({
		currentConfig: config,
		label: "linters.cargo-symbol-length",
	});

	const rawRuns = runs || readRunEntries(entriesDir);
	const normalizedRuns = rawRuns.map((run) => {
		const normalized = normalizeRun(run, resolvedConfig);
		// Attach raw stdout/stderr for details rendering (stripped on output)
		normalized._stdout = String(run?.stdout || "");
		normalized._stderr = String(run?.stderr || "");
		return normalized;
	});

	const preludeText =
		typeof detailsPath === "string" && detailsPath.length > 0
			? readTextFile(detailsPath).trim()
			: "";
	const requestedExitCode = Number.parseInt(String(commandExitCode), 10) || 0;
	const details = buildDetails(
		requestedExitCode !== 0 || normalizedRuns.length === 0 ? preludeText : "",
		normalizedRuns,
		resolvedConfig,
	);

	const totalFindings = normalizedRuns.reduce(
		(sum, run) => sum + run.findings.length,
		0,
	);
	const exit_code = requestedExitCode !== 0 || totalFindings > 0 ? 1 : 0;

	// Strip internal rendering state before output
	const outputRuns = normalizedRuns.map(
		({
			command,
			exit_code: runExitCode,
			findings,
			manifest_path,
			target_kind,
			target_name,
			target_src_path,
		}) => ({
			command,
			exit_code: runExitCode,
			findings,
			manifest_path,
			target_kind,
			target_name,
			target_src_path,
		}),
	);

	return {
		cargo_symbol_length_runs: outputRuns,
		details,
		exit_code,
	};
}

if (require.main === module) {
	const [entriesDir, detailsPath, configPath, exitCodeRaw] =
		process.argv.slice(2);

	if (
		!entriesDir ||
		!detailsPath ||
		!configPath ||
		typeof exitCodeRaw !== "string"
	) {
		throw new Error(
			"usage: cargo-symbol-length-result.js <entries-dir> <details-path> <config-path> <exit-code>",
		);
	}

	const result = buildCargoSymbolLengthResult({
		commandExitCode: exitCodeRaw,
		config: readJsonFile(configPath) || {},
		detailsPath,
		entriesDir,
	});

	process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
	buildCargoSymbolLengthResult,
	readRunEntries,
};
