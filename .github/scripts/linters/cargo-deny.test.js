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
} = require("./cargo-linter-test-lib");

const scriptPath = path.join(__dirname, "cargo-deny.sh");

function createEnv(context, extraEnv = {}) {
	return {
		...process.env,
		...extraEnv,
		PATH: `${context.binDir}:${process.env.PATH}`,
		RUNNER_TEMP: context.runnerTemp,
	};
}

function createReleaseAsset(assetPath, version) {
	const rootDir = path.join(
		path.dirname(assetPath),
		`cargo-deny-${version}-x86_64-unknown-linux-musl`,
	);

	fs.mkdirSync(rootDir, { recursive: true });
	writeExecutable(
		path.join(rootDir, "cargo-deny"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "cargo-deny ${version}"
  exit 0
fi
exit 0
`,
	);
	execFileSync("tar", [
		"-czf",
		assetPath,
		"-C",
		path.dirname(assetPath),
		`cargo-deny-${version}-x86_64-unknown-linux-musl`,
	]);
}

function createRustupInitStub(filePath) {
	writeExecutable(
		filePath,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$RUSTUP_INIT_ARGS_LOG"
mkdir -p "$CARGO_HOME/bin"
cat > "$CARGO_HOME/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "cargo 0.0.0"
  exit 0
fi
exit 0
EOF
chmod +x "$CARGO_HOME/bin/cargo"
`,
	);
}

function createCurlStub(binDir) {
	writeExecutable(
		path.join(binDir, "curl"),
		`#!/usr/bin/env bash
set -euo pipefail
out_file=""
write_format=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -w)
      write_format="$2"
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
case "$url" in
  https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init)
    cp "$RUSTUP_INIT_SOURCE" "$out_file"
    ;;
  https://github.com/EmbarkStudios/cargo-deny/releases/latest)
    if [ -n "$out_file" ] && [ "$out_file" != "/dev/null" ]; then
      : > "$out_file"
    fi
    if [ "$write_format" = "%{url_effective}" ]; then
      printf '%s' "\${CARGO_DENY_RELEASE_URL:-https://github.com/EmbarkStudios/cargo-deny/releases/tag/0.19.0}"
    fi
    ;;
  https://github.com/EmbarkStudios/cargo-deny/releases/download/*)
    cp "$CARGO_DENY_ASSET_SOURCE" "$out_file"
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
`,
	);
}

function createCargoStub(binDir) {
	writeExecutable(
		path.join(binDir, "cargo"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "cargo 0.0.0"
  exit 0
fi
if [ "\${1-}" != "metadata" ]; then
  echo "unexpected cargo command: $*" >&2
  exit 1
fi
shift
manifest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-path|--format-version)
      if [ "$1" = "--manifest-path" ]; then
        manifest="$2"
      fi
      shift 2
      ;;
    --no-deps)
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$manifest" ]; then
  echo "missing --manifest-path" >&2
  exit 1
fi
current_dir=$(dirname "$manifest")
workspace_dir="$current_dir"
search_dir="$current_dir"
while :; do
  candidate="$search_dir/Cargo.toml"
  if [ -f "$candidate" ] && grep -Eq '^\\[workspace\\]' "$candidate"; then
    workspace_dir="$search_dir"
    break
  fi
  if [ "$search_dir" = "." ] || [ "$search_dir" = "/" ]; then
    break
  fi
  search_dir=$(dirname "$search_dir")
done
workspace_root=$(cd "$workspace_dir" && pwd)
node - "$workspace_root" <<'NODE'
const [workspaceRoot] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ workspace_root: workspaceRoot }));
NODE
`,
	);
}

function createCargoDenyStub(binDir) {
	createCargoStub(binDir);
	writeExecutable(
		path.join(binDir, "cargo-deny"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "--version" ]; then
  echo "cargo-deny 0.0.0"
  exit 0
fi
manifest=""
config=""
audit_mode=0
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-path|--config|--format)
      if [ "$1" = "--manifest-path" ]; then
        manifest="$2"
      fi
      if [ "$1" = "--config" ]; then
        config="$2"
      fi
      args+=("$1" "$2")
      shift 2
      ;;
    --audit-compatible-output)
      audit_mode=1
      args+=("$1")
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
printf '%s\\n' "\${args[*]}" >> "$CARGO_DENY_ARGS_LOG"
if [ "$audit_mode" -eq 1 ] && {
  [ -n "\${AUDIT_REPORT_MANIFEST:-}" ] && [ "$manifest" = "$AUDIT_REPORT_MANIFEST" ] || \
  [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ];
}; then
  node - "$manifest" <<'NODE'
const manifest = process.argv[2];
const packageName =
  manifest === "Cargo.toml"
    ? "root"
    : manifest.slice(0, -"/Cargo.toml".length);
process.stdout.write(
  JSON.stringify({
    settings: {},
    lockfile: { "dependency-count": 1 },
    vulnerabilities: [
      {
        advisory: {
          id: "RUSTSEC-2024-0001",
          title: "issue in " + manifest,
        },
        package: {
          name: packageName,
          version: "0.1.0",
        },
      },
    ],
    warnings: {},
  }),
);
process.stdout.write("\\n");
NODE
fi
if [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_MANIFEST" ]; then
  if [ "$audit_mode" -eq 1 ]; then
    node - "$manifest" "$config" <<'NODE'
const [manifest, config] = process.argv.slice(2);
process.stderr.write(
  JSON.stringify({
    type: "diagnostic",
    fields: {
      code: "rejected",
      labels: [
        {
          column: 1,
          line: 1,
          message: "simulated cargo-deny issue",
          span: config || manifest,
        },
      ],
      message: "issue in " + manifest,
      notes: [],
      severity: "error",
    },
  }),
);
process.stderr.write("\\n");
NODE
  else
    printf 'issue in %s\\n' "$manifest" >&2
  fi
  exit 1
fi
printf 'checked %s\\n' "$manifest" >&2
`,
	);
}

test("cargo-deny.sh patterns match Cargo dependency and policy files", () => {
	const output = execFileSync("bash", [scriptPath, "patterns"], {
		encoding: "utf8",
	});
	const patterns = output
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((pattern) => new RegExp(pattern, "i"));

	const matches = (filePath) =>
		patterns.some((pattern) => pattern.test(filePath));

	assert.equal(matches("Cargo.toml"), true);
	assert.equal(matches("Cargo.lock"), true);
	assert.equal(matches("deny.toml"), true);
	assert.equal(matches(".cargo/config"), true);
	assert.equal(matches(".cargo/config.toml"), true);
	assert.equal(matches("crates/member/Cargo.toml"), true);
	assert.equal(matches("src/lib.rs"), false);
	assert.equal(matches("README.md"), false);
});

test("cargo-deny.sh install downloads the latest release archive and extracts cargo-deny", () => {
	const context = makeTempRepo("cargo-deny-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const rustupInitLog = path.join(context.tempDir, "rustup-init.log");
	const version = "0.19.0";
	const assetPath = path.join(
		context.tempDir,
		`cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz`,
	);
	const rustupInitPath = path.join(context.tempDir, "rustup-init");

	createReleaseAsset(assetPath, version);
	createRustupInitStub(rustupInitPath);
	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [scriptPath, "install"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ASSET_SOURCE: assetPath,
				CARGO_DENY_RELEASE_URL:
					"https://github.com/EmbarkStudios/cargo-deny/releases/tag/0.19.0",
				CURL_URL_LOG: curlUrlLog,
				RUSTUP_INIT_ARGS_LOG: rustupInitLog,
				RUSTUP_INIT_SOURCE: rustupInitPath,
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init",
			"https://github.com/EmbarkStudios/cargo-deny/releases/latest",
			"https://github.com/EmbarkStudios/cargo-deny/releases/download/0.19.0/cargo-deny-0.19.0-x86_64-unknown-linux-musl.tar.gz",
		]);
		assert.match(
			fs.readFileSync(rustupInitLog, "utf8"),
			/--profile minimal --default-toolchain stable --no-modify-path/,
		);
		assert.equal(
			fs.existsSync(path.join(context.runnerTemp, "cargo/bin/cargo-deny")),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh groups selected dependency files by nearest Cargo.toml and prefers nearest deny.toml", () => {
	const context = makeTempRepo("cargo-deny-grouped-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "Cargo.lock"), "version = 3\n");
	writeFile(
		path.join(context.repoDir, "deny.toml"),
		"[graph]\nall-features = true\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/deny.toml"),
		"[graph]\nall-features = false\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "deny.toml", "Cargo.lock", "crates/member/deny.toml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					CARGO_DENY_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			result.cargo_deny_runs.map((run) => run.manifest_path),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"--format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
			"--format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output --config crates/member/deny.toml",
		]);
		assert.match(
			result.details,
			/cargo-deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output --config deny\.toml/,
		);
		assert.match(
			result.details,
			/cargo-deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output --config crates\/member\/deny\.toml/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh collapses workspace members to a single workspace-root run", () => {
	const context = makeTempRepo("cargo-deny-workspace-root-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[workspace]
members = ["crates/member"]
resolver = "2"
`,
	);
	writeFile(path.join(context.repoDir, "Cargo.lock"), "version = 3\n");
	writeFile(
		path.join(context.repoDir, "deny.toml"),
		"[graph]\nall-features = true\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "Cargo.lock", "crates/member/Cargo.toml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					CARGO_DENY_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.equal(result.cargo_deny_runs[0].manifest_path, "Cargo.toml");
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"--format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
		]);
		assert.doesNotMatch(
			result.details,
			/--manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh maps repo-root deny.toml to nested Cargo manifests", () => {
	const context = makeTempRepo("cargo-deny-root-policy-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "deny.toml"),
		"[graph]\nall-features = true\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);

	try {
		const output = execFileSync("bash", [scriptPath, "run", "deny.toml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"--format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output --config deny.toml",
		]);
		assert.match(
			result.details,
			/cargo-deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output --config deny\.toml/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh omits --config when no deny.toml is found and continues after one manifest fails", () => {
	const context = makeTempRepo("cargo-deny-no-config-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "Cargo.lock"), "version = 3\n");
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "Cargo.lock", "crates/member/Cargo.toml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					AUDIT_REPORT_MANIFEST: "Cargo.toml",
					CARGO_DENY_ARGS_LOG: argsLog,
					FAIL_MANIFEST: "Cargo.toml",
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.cargo_deny_runs.length, 2);
		assert.equal(
			result.cargo_deny_runs[0].audit_reports[0].vulnerabilities[0].advisory.id,
			"RUSTSEC-2024-0001",
		);
		assert.equal(
			result.cargo_deny_runs[0].diagnostics[0].fields.code,
			"rejected",
		);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"--format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output",
			"--format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output",
		]);
		assert.match(
			result.details,
			/error\[RUSTSEC-2024-0001\]: root 0\.1\.0 - issue in Cargo\.toml/,
		);
		assert.match(result.details, /error\[rejected\]: issue in Cargo\.toml/);
		assert.match(
			result.details,
			/cargo-deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh reports selected files outside Cargo packages", () => {
	const context = makeTempRepo("cargo-deny-missing-manifest-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(path.join(context.repoDir, "policies/deny.toml"), "[graph]\n");

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", "policies/deny.toml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					CARGO_DENY_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(
			result.details,
			/Cargo deny requires each selected file to belong to a Cargo package\./,
		);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(result.details, /policies\/deny\.toml/);
		assert.equal(fs.existsSync(argsLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh rejects repository-supplied Cargo config on the shared path", () => {
	const context = makeTempRepo("cargo-deny-unsupported-cargo-config-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		"[build]\ntarget-dir = 'target'\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[scriptPath, "run", ".cargo/config.toml"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					CARGO_DENY_ARGS_LOG: argsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(
			result.details,
			/Repository-supplied `.cargo\/config\.toml` is not supported/,
		);
		assert.match(result.details, /cargo metadata/);
		assert.doesNotMatch(result.details, /No Cargo\.toml found for:/);
		assert.equal(fs.existsSync(argsLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
