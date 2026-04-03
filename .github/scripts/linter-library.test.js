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
