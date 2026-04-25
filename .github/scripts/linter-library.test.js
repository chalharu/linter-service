const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("linter-library.sh emits JSON via Node when Python is unavailable", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const outputPath = path.join(tempDir, "output.txt");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(outputPath, "example details\n", "utf8");
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v node)")"
linter_lib::emit_json_result 1 "${outputPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			details: "example details",
			exit_code: 1,
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh embeds parsed SARIF JSON via Node when Python is unavailable", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const sarifPath = path.join(tempDir, "result.sarif");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		sarifPath,
		JSON.stringify({
			runs: [
				{
					results: [{ message: { text: "native failure" }, ruleId: "parse" }],
				},
			],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v node)")"
linter_lib::emit_json_result_with_sarif 1 "${sarifPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [{ message: { text: "native failure" }, ruleId: "parse" }],
					},
				],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh embeds parsed JSON via Python when available", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const payloadPath = path.join(tempDir, "payload.json");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		payloadPath,
		JSON.stringify({
			runs: [
				{
					results: [{ message: { text: "native failure" }, ruleId: "parse" }],
				},
			],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v python3)")"
linter_lib::emit_json_result_with_json_file 1 sarif "${payloadPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [{ message: { text: "native failure" }, ruleId: "parse" }],
					},
				],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh derives findings exit_code from SARIF via Node", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const sarifPath = path.join(tempDir, "result.sarif");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		sarifPath,
		JSON.stringify({
			runs: [
				{
					results: [{ message: { text: "native failure" }, ruleId: "parse" }],
				},
			],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v node)")"
linter_lib::emit_json_result_with_sarif_findings "${sarifPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [{ message: { text: "native failure" }, ruleId: "parse" }],
					},
				],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh derives empty-findings exit_code from SARIF via Node", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const sarifPath = path.join(tempDir, "result.sarif");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		sarifPath,
		JSON.stringify({
			runs: [{ results: [] }],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v node)")"
linter_lib::emit_json_result_with_sarif_findings "${sarifPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 0,
			sarif: {
				runs: [{ results: [] }],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh derives findings exit_code from SARIF via Python", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const sarifPath = path.join(tempDir, "result.sarif");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		sarifPath,
		JSON.stringify({
			runs: [
				{
					results: [{ message: { text: "native failure" }, ruleId: "parse" }],
				},
			],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v python3)")"
linter_lib::emit_json_result_with_sarif_findings "${sarifPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 1,
			sarif: {
				runs: [
					{
						results: [{ message: { text: "native failure" }, ruleId: "parse" }],
					},
				],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("linter-library.sh derives empty-findings exit_code from SARIF via Python", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-library-"));
	const sarifPath = path.join(tempDir, "result.sarif");
	const runnerScript = path.join(tempDir, "runner.sh");

	fs.writeFileSync(
		sarifPath,
		JSON.stringify({
			runs: [{ results: [] }],
			version: "2.1.0",
		}),
		"utf8",
	);
	fs.writeFileSync(
		runnerScript,
		`#!/usr/bin/env bash
set -euo pipefail
source "${path.join(process.cwd(), ".github/scripts/linter-library.sh")}"
PATH="$(dirname "$(command -v python3)")"
linter_lib::emit_json_result_with_sarif_findings "${sarifPath}"
`,
		"utf8",
	);
	fs.chmodSync(runnerScript, 0o755);

	try {
		const output = execFileSync("bash", [runnerScript], {
			encoding: "utf8",
		});

		assert.deepEqual(JSON.parse(output), {
			exit_code: 0,
			sarif: {
				runs: [{ results: [] }],
				version: "2.1.0",
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
