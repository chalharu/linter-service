const test = require("node:test");
const { execFileSync } = require("node:child_process");
const {
	assert,
	cleanupTempRepo,
	fs,
	makeTempRepo,
	path,
	readPinnedVersion,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const patternsPath = path.join(__dirname, "patterns.sh");
const installPath = path.join(__dirname, "install.sh");
const runPath = path.join(__dirname, "run.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createCurlStub(binDir) {
	writeExecutable(
		path.join(binDir, "curl"),
		`#!/usr/bin/env bash
	set -euo pipefail
	out_file=""
	url=""
	while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
	    -f|-s|-S|-L|-fsSL)
	      shift
	      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
	done
	printf '%s\\n' "$url" >> "$CURL_URL_LOG"
	printf 'archive' > "$out_file"
`,
	);
}

function createTarStub(binDir) {
	writeExecutable(
		path.join(binDir, "tar"),
		`#!/usr/bin/env bash
set -euo pipefail
extract_dir=""
archive_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C)
      extract_dir="$2"
      shift 2
      ;;
    -xzf)
      archive_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\\n' "$archive_path" >> "$TAR_ARCHIVE_LOG"
mkdir -p "$extract_dir/bin"
cat > "$extract_dir/bin/ec-linux-amd64" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$extract_dir/bin/ec-linux-amd64"
`,
	);
}

function createMissingVersionStub(binDir) {
	writeExecutable(
		path.join(binDir, "editorconfig-checker"),
		`#!/usr/bin/env bash
exit 1
`,
	);
}

function createEditorconfigCheckerStub(binDir) {
	writeExecutable(
		path.join(binDir, "editorconfig-checker"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${EDITORCONFIG_CHECKER_LOG:-}" ]; then
  printf 'cwd=%s\\n' "$PWD" >> "$EDITORCONFIG_CHECKER_LOG"
  printf 'args=%s\\n' "$*" >> "$EDITORCONFIG_CHECKER_LOG"
fi
if [ -n "\${FAIL_RUN:-}" ]; then
  printf 'editorconfig issue\\n' >&2
  exit 1
fi
printf 'editorconfig checked\\n'
`,
	);
}

test("editorconfig-checker.sh patterns match text-like files and skip common binary or generated files", () => {
	const output = execFileSync("bash", [patternsPath], {
		encoding: "utf8",
	});
	const patterns = output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((pattern) => new RegExp(pattern, "i"));

	const matches = (filePath) =>
		patterns.some((pattern) => pattern.test(filePath));

	assert.equal(matches("README.md"), true);
	assert.equal(matches(".editorconfig"), true);
	assert.equal(matches("src/main.rs"), true);
	assert.equal(matches("services/api/Dockerfile"), true);
	assert.equal(matches("docs/image.png"), false);
	assert.equal(matches("package-lock.json"), false);
	assert.equal(matches("node_modules/pkg/index.js"), false);
	assert.equal(matches("target/debug/app"), false);
	assert.equal(matches(".terraform.lock.hcl"), false);
	assert.equal(matches("gradle/wrapper/gradle-wrapper.properties"), false);
	assert.equal(matches(".mvn/wrapper/maven-wrapper.properties"), false);
	assert.equal(matches(".mvn/wrapper/MavenWrapperDownloader.java"), false);
	assert.equal(matches("buildscript-gradle.lockfile"), false);
	assert.equal(matches("dist/app.min.js"), false);
});

test("editorconfig-checker.sh install downloads the pinned Linux amd64 release archive", () => {
	const context = makeTempRepo("editorconfig-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const tarArchiveLog = path.join(context.tempDir, "tar-archives.log");
	const version = readPinnedVersion(
		installPath,
		"editorconfig_checker_version",
	);

	createCurlStub(context.binDir);
	createTarStub(context.binDir);
	createMissingVersionStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CURL_URL_LOG: curlUrlLog,
				TAR_ARCHIVE_LOG: tarArchiveLog,
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			`https://github.com/editorconfig-checker/editorconfig-checker/releases/download/${version}/ec-linux-amd64.tar.gz`,
		]);
		assert.equal(
			fs.readFileSync(tarArchiveLog, "utf8").trim(),
			path.join(context.runnerTemp, "ec-linux-amd64.tar.gz"),
		);
		assert.equal(
			fs.existsSync(
				path.join(
					context.runnerTemp,
					"editorconfig-checker/bin/editorconfig-checker",
				),
			),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("editorconfig-checker.sh merges repo config, copies relevant .editorconfig files, and limits checks to changed files", () => {
	const context = makeTempRepo("editorconfig-run-");
	const editorconfigLog = path.join(context.tempDir, "editorconfig.log");

	createEditorconfigCheckerStub(context.binDir);

	writeFile(path.join(context.repoDir, ".editorconfig"), "root = true\n");
	writeFile(
		path.join(context.repoDir, "services/.editorconfig"),
		"[*.js]\nindent_style = space\n",
	);
	writeFile(
		path.join(context.repoDir, ".editorconfig-checker.json"),
		`${JSON.stringify(
			{
				Exclude: ["vendor"],
				IgnoreDefaults: true,
				NoColor: false,
				PassedFiles: ["old-file.txt"],
				Version: "v0.0.1",
			},
			null,
			2,
		)}\n`,
	);
	writeFile(
		path.join(context.repoDir, "services/api/app.js"),
		"const value = 1;\n",
	);

	try {
		const output = execFileSync("bash", [runPath, "services/api/app.js"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				EDITORCONFIG_CHECKER_LOG: editorconfigLog,
			}),
		});
		const result = JSON.parse(output);
		const tempRepo = path.join(context.runnerTemp, "editorconfig-checker-repo");
		const mergedConfig = JSON.parse(
			fs.readFileSync(
				path.join(tempRepo, ".editorconfig-checker.shared.json"),
				"utf8",
			),
		);
		const log = fs.readFileSync(editorconfigLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.match(log, /cwd=.*editorconfig-checker-repo/);
		assert.match(log, /args=-config \.editorconfig-checker\.shared\.json/);
		assert.deepEqual(mergedConfig.PassedFiles, ["services/api/app.js"]);
		assert.equal(mergedConfig.NoColor, true);
		assert.equal(mergedConfig.IgnoreDefaults, true);
		assert.deepEqual(mergedConfig.Exclude, ["vendor"]);
		assert.equal("Version" in mergedConfig, false);
		assert.equal(fs.existsSync(path.join(tempRepo, ".editorconfig")), true);
		assert.equal(
			fs.existsSync(path.join(tempRepo, "services/.editorconfig")),
			true,
		);
		assert.equal(
			fs.existsSync(path.join(tempRepo, "services/api/app.js")),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("editorconfig-checker.sh falls back to .ecrc when the modern config file is absent", () => {
	const context = makeTempRepo("editorconfig-ecrc-");
	const editorconfigLog = path.join(context.tempDir, "editorconfig.log");

	createEditorconfigCheckerStub(context.binDir);

	writeFile(
		path.join(context.repoDir, ".ecrc"),
		`${JSON.stringify(
			{
				Debug: true,
			},
			null,
			2,
		)}\n`,
	);
	writeFile(path.join(context.repoDir, "docs/guide.md"), "# Guide\n");

	try {
		const output = execFileSync("bash", [runPath, "docs/guide.md"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				EDITORCONFIG_CHECKER_LOG: editorconfigLog,
			}),
		});
		const result = JSON.parse(output);
		const mergedConfig = JSON.parse(
			fs.readFileSync(
				path.join(
					context.runnerTemp,
					"editorconfig-checker-repo/.editorconfig-checker.shared.json",
				),
				"utf8",
			),
		);

		assert.equal(result.exit_code, 0);
		assert.equal(mergedConfig.Debug, true);
		assert.deepEqual(mergedConfig.PassedFiles, ["docs/guide.md"]);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("editorconfig-checker.sh reports failures from the underlying checker", () => {
	const context = makeTempRepo("editorconfig-failure-");

	createEditorconfigCheckerStub(context.binDir);
	writeFile(path.join(context.repoDir, "README.md"), "trailing space \n");

	try {
		const output = execFileSync("bash", [runPath, "README.md"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				FAIL_RUN: "1",
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /editorconfig issue/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
