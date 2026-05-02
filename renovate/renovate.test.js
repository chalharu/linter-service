const test = require("node:test");
const { execFileSync } = require("node:child_process");
const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const runPath = path.join(__dirname, "run.sh");

/**
 * Create a stub docker binary that records its invocation arguments into
 * $RUNNER_TEMP/docker-args.json using `node -- "$@"` so that every shell
 * argument is faithfully captured as a JSON array element.
 */
function createDockerStub(context, { exitCode = 0 } = {}) {
	writeExecutable(
		path.join(context.binDir, "docker"),
		// Pass all shell args through node's process.argv so that values with
		// spaces, commas, etc. are preserved without any shell quoting issues.
		`#!/usr/bin/env bash
set -euo pipefail
node -e "
const fs = require('node:fs');
fs.writeFileSync(
  process.env.RUNNER_TEMP + '/docker-args.json',
  JSON.stringify(process.argv.slice(1)),
  'utf8',
);
" -- "$@"
exit ${exitCode}
`,
	);
}

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
		// Skip image-tag resolution (git, sha256sum) — use a fixed ref.
		RENOVATE_IMAGE_REF: "renovate-stub:latest",
	};
}

function readDockerArgs(context) {
	const argsFile = path.join(context.runnerTemp, "docker-args.json");
	return JSON.parse(fs.readFileSync(argsFile, "utf8"));
}

function writeRenovateConfig(repoDir) {
	writeFile(
		path.join(repoDir, "renovate.json"),
		JSON.stringify({
			$schema: "https://docs.renovatebot.com/renovate-schema.json",
		}) + "\n",
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renovate/run.sh passes required isolation flags to docker", () => {
	const context = makeTempRepo("renovate-isolation-");
	createDockerStub(context);
	writeRenovateConfig(context.repoDir);

	try {
		execFileSync("bash", [runPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context),
		});

		const args = readDockerArgs(context);

		// Subcommand must be "run"
		assert.equal(args[0], "run");

		// Required isolation flags must all be present.
		assert.ok(args.includes("--rm"), "--rm must be passed");
		assert.ok(args.includes("--cap-drop"), "--cap-drop must be passed");
		assert.ok(args.includes("ALL"), "ALL must follow --cap-drop");
		assert.ok(args.includes("--security-opt"), "--security-opt must be passed");
		assert.ok(
			args.includes("no-new-privileges"),
			"no-new-privileges must follow --security-opt",
		);
		assert.ok(args.includes("--read-only"), "--read-only must be passed");
		assert.ok(args.includes("--tmpfs"), "--tmpfs must be passed");
		assert.ok(args.includes("/tmp"), "/tmp must follow --tmpfs");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("renovate/run.sh does NOT pass --network=none (Renovate needs network for remote datasources)", () => {
	const context = makeTempRepo("renovate-no-network-none-");
	createDockerStub(context);
	writeRenovateConfig(context.repoDir);

	try {
		execFileSync("bash", [runPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context),
		});

		const args = readDockerArgs(context);

		// --network=none must NOT be present.  Renovate requires network access for
		// remote datasources such as git-refs whose packageName is a fully-qualified
		// HTTPS URL.
		assert.ok(
			!args.includes("--network=none"),
			"--network=none must NOT be passed; Renovate requires network for remote datasources",
		);

		// Guard the two-token form as well: `--network` `none`
		const networkIdx = args.indexOf("--network");
		if (networkIdx !== -1) {
			assert.notEqual(
				args[networkIdx + 1],
				"none",
				"--network none must NOT be passed",
			);
		}
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("renovate/run.sh passes readonly bind mount for the workspace", () => {
	const context = makeTempRepo("renovate-bind-mount-");
	createDockerStub(context);
	writeRenovateConfig(context.repoDir);

	try {
		execFileSync("bash", [runPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context),
		});

		const args = readDockerArgs(context);

		// Find every value that follows a --mount flag.
		const mountValues = args
			.map((a, i) => (a === "--mount" ? args[i + 1] : null))
			.filter(Boolean);

		// The workspace must be bind-mounted with the readonly marker.
		const hasWorkReadonly = mountValues.some(
			(v) => v.includes(context.repoDir) && v.includes("readonly"),
		);
		assert.ok(hasWorkReadonly, "workspace must be bind-mounted read-only");
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("renovate/run.sh does NOT pass --network=none when an explicit config path is supplied", () => {
	const context = makeTempRepo("renovate-explicit-config-");
	createDockerStub(context);
	writeRenovateConfig(context.repoDir);

	try {
		execFileSync("bash", [runPath, "renovate.json"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context),
		});

		const args = readDockerArgs(context);

		assert.ok(
			!args.includes("--network=none"),
			"--network=none must NOT be passed even when config path is explicit",
		);

		const networkIdx = args.indexOf("--network");
		if (networkIdx !== -1) {
			assert.notEqual(
				args[networkIdx + 1],
				"none",
				"--network none must NOT be passed even when config path is explicit",
			);
		}
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
