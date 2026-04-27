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
	case "$url" in
	  https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init)
	    cp "$RUSTUP_INIT_SOURCE" "$out_file"
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
	writeExecutable(
		path.join(binDir, "docker"),
		`#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift

if [ "$command" != "run" ]; then
  echo "unsupported docker command: $command" >&2
  exit 1
fi

work_mount_src=""
container_workdir="/work"
image_ref=""
command_args=()
option_with_value=""
for arg in "$@"; do
  if [ -n "$option_with_value" ]; then
    case "$option_with_value" in
      --mount)
        case "$arg" in
          *"dst=/work"*|*"target=/work"*)
            work_mount_src="\${arg#*src=}"
            work_mount_src="\${work_mount_src%%,*}"
            ;;
        esac
        ;;
      --workdir)
        container_workdir="$arg"
        ;;
    esac
    option_with_value=""
    continue
  fi
  case "$arg" in
    --mount|--user|--workdir|--tmpfs|--security-opt|--cap-drop|--env|-e)
      option_with_value="$arg"
      continue
      ;;
    --rm|--read-only|--network=*)
      continue
      ;;
  esac
  if [ -z "$image_ref" ]; then
    image_ref="$arg"
    continue
  fi
  command_args+=("$arg")
done

if [ "\${command_args[0]:-}" != "cargo" ]; then
  echo "unsupported docker cargo invocation: \${command_args[*]}" >&2
  exit 1
fi

cargo_config_args=()
index=1
while [ "$index" -lt "\${#command_args[@]}" ]; do
  arg="\${command_args[$index]}"
  if [ "$arg" = "--config" ]; then
    cargo_config_args+=("\${command_args[$((index + 1))]}")
    index=$((index + 2))
    continue
  fi
  cargo_subcommand="$arg"
  index=$((index + 1))
  break
done

subcommand_args=("\${command_args[@]:$index}")

manifest=""
config=""
audit_mode=0
prev=""
for arg in "\${subcommand_args[@]}"; do
  case "$prev" in
    --manifest-path)
      manifest="$arg"
      ;;
    --config)
      config="$arg"
      ;;
  esac
  if [ "$arg" = "--audit-compatible-output" ]; then
    audit_mode=1
  fi
  prev="$arg"
done

if [ -n "$manifest" ]; then
  manifest=$(node - "$container_workdir" "$manifest" <<'NODE'
const path = require("node:path");
const [workdir, manifest] = process.argv.slice(2);
const absolute = manifest.startsWith("/work")
  ? path.posix.normalize(manifest)
  : path.posix.normalize(path.posix.join(workdir || "/work", manifest));
process.stdout.write(
  absolute === "/work"
    ? ""
    : absolute.startsWith("/work/")
      ? absolute.slice("/work/".length)
      : absolute,
);
NODE
)
  manifest_host_path=$(node - "$work_mount_src" "$manifest" <<'NODE'
const path = require("node:path");
const [sourceRoot, manifest] = process.argv.slice(2);
process.stdout.write(path.join(sourceRoot, ...manifest.split("/")));
NODE
)
else
  manifest_host_path=""
fi

if [ -n "$config" ]; then
  config=$(node - "$container_workdir" "$config" <<'NODE'
const path = require("node:path");
const [workdir, config] = process.argv.slice(2);
const absolute = config.startsWith("/work")
  ? path.posix.normalize(config)
  : path.posix.normalize(path.posix.join(workdir || "/work", config));
process.stdout.write(
  absolute === "/work"
    ? ""
    : absolute.startsWith("/work/")
      ? absolute.slice("/work/".length)
      : absolute,
);
NODE
)
fi

normalized_command_args=("\${command_args[@]}")
normalized_prev=""
for i in "\${!normalized_command_args[@]}"; do
  case "$normalized_prev" in
    --manifest-path)
      normalized_command_args[$i]="$manifest"
      ;;
    --config)
      normalized_command_args[$i]="$config"
      ;;
  esac
  normalized_prev="\${normalized_command_args[$i]}"
done

if [ "$cargo_subcommand" = "metadata" ]; then
  if [ -z "$manifest" ]; then
    echo "missing --manifest-path" >&2
    exit 1
  fi
  current_dir=$(dirname "$manifest_host_path")
  workspace_dir="$current_dir"
  search_dir="$current_dir"
  while :; do
    candidate="$search_dir/Cargo.toml"
    if [ -f "$candidate" ] && grep -Eq '^\\[workspace\\]' "$candidate"; then
      workspace_dir="$search_dir"
      break
    fi
    if [ "$search_dir" = "$work_mount_src" ] || [ "$search_dir" = "/" ]; then
      break
    fi
    search_dir=$(dirname "$search_dir")
  done
  node - "$work_mount_src" "$workspace_dir" <<'NODE'
const path = require("node:path");
const [sourceRoot, workspaceDir] = process.argv.slice(2);
const relativeDir = path.relative(sourceRoot, workspaceDir);
const workspaceRoot =
  relativeDir.length === 0
    ? "/work"
    : path.posix.join("/work", ...relativeDir.split(path.sep));
process.stdout.write(JSON.stringify({ workspace_root: workspaceRoot }));
NODE
  exit 0
fi

if [ "$cargo_subcommand" != "deny" ]; then
  echo "unexpected cargo subcommand: $cargo_subcommand" >&2
  exit 1
fi

printf '%s\\n' "\${normalized_command_args[*]}" >> "$CARGO_DENY_ARGS_LOG"
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
if [ -n "\${DUPLICATE_WARNING_MANIFEST:-}" ] && [ "$manifest" = "$DUPLICATE_WARNING_MANIFEST" ]; then
  if [ "$audit_mode" -eq 1 ]; then
    node <<'NODE'
process.stdout.write(
  JSON.stringify({
    settings: {},
    lockfile: { "dependency-count": 1 },
    vulnerabilities: {
      count: 0,
      found: false,
      list: [],
    },
    warnings: {},
  }),
);
process.stdout.write("\\n");
process.stderr.write(
  JSON.stringify({
    type: "diagnostic",
    fields: {
      code: "duplicate",
      labels: [
        {
          column: 1,
          line: 1,
          message: "lock entries",
          span: [
            "demo 0.1.0 registry+https://github.com/rust-lang/crates.io-index",
            "demo 0.2.0 registry+https://github.com/rust-lang/crates.io-index",
          ].join("\\n"),
        },
      ],
      message: "found 2 duplicate entries for crate 'demo'",
      notes: [],
      severity: "warning",
    },
  }),
);
process.stderr.write("\\n");
process.stderr.write(
  JSON.stringify({
    type: "summary",
    fields: {
      advisories: { errors: 0, helps: 0, notes: 0, warnings: 0 },
      bans: { errors: 0, helps: 0, notes: 0, warnings: 1 },
      licenses: { errors: 0, helps: 0, notes: 0, warnings: 0 },
      sources: { errors: 0, helps: 0, notes: 0, warnings: 0 },
    },
  }),
);
process.stderr.write("\\n");
NODE
  fi
  exit 1
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

	assert.equal(matches("Cargo.toml"), true);
	assert.equal(matches("Cargo.lock"), true);
	assert.equal(matches("deny.toml"), true);
	assert.equal(matches(".cargo/config"), true);
	assert.equal(matches(".cargo/config.toml"), true);
	assert.equal(matches("crates/member/Cargo.toml"), true);
	assert.equal(matches("src/lib.rs"), false);
	assert.equal(matches("README.md"), false);
});

test("cargo-deny.sh install downloads the pinned release archive and extracts cargo-deny", () => {
	const context = makeTempRepo("cargo-deny-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const rustupInitLog = path.join(context.tempDir, "rustup-init.log");
	const version = readPinnedVersion(installPath, "cargo_deny_version");
	const toolchainVersion = readPinnedVersion(
		installPath,
		"rust_toolchain_version",
	);
	const assetPath = path.join(
		context.tempDir,
		`cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz`,
	);
	const rustupInitPath = path.join(context.tempDir, "rustup-init");

	createReleaseAsset(assetPath, version);
	createRustupInitStub(rustupInitPath);
	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...createEnv(context, {
					CARGO_DENY_ASSET_SOURCE: assetPath,
					CURL_URL_LOG: curlUrlLog,
					RUSTUP_INIT_ARGS_LOG: rustupInitLog,
					RUSTUP_INIT_SOURCE: rustupInitPath,
				}),
				CARGO_HOME: path.join(context.runnerTemp, "cargo"),
				PATH: `${context.binDir}:/usr/bin:/bin`,
				RUSTUP_HOME: path.join(context.runnerTemp, "rustup"),
			},
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init",
			`https://github.com/EmbarkStudios/cargo-deny/releases/download/${version}/cargo-deny-${version}-x86_64-unknown-linux-musl.tar.gz`,
		]);
		assert.match(
			fs.readFileSync(rustupInitLog, "utf8"),
			new RegExp(
				`--profile minimal --default-toolchain ${toolchainVersion} --no-modify-path`,
				"u",
			),
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
			[runPath, "deny.toml", "Cargo.lock", "crates/member/deny.toml"],
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
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output --config crates/member/deny.toml",
		]);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output --config deny\.toml/,
		);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output --config crates\/member\/deny\.toml/,
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
			[runPath, "Cargo.lock", "crates/member/Cargo.toml"],
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
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
		]);
		assert.doesNotMatch(
			result.details,
			/--manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh keeps a workspace-root run while using the nearest member deny.toml", () => {
	const context = makeTempRepo("cargo-deny-workspace-member-config-");
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
		const output = execFileSync("bash", [runPath, "crates/member/deny.toml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.equal(result.cargo_deny_runs[0].manifest_path, "Cargo.toml");
		assert.equal(
			result.cargo_deny_runs[0].config_path,
			"crates/member/deny.toml",
		);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config crates/member/deny.toml",
		]);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output --config crates\/member\/deny\.toml/,
		);
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
		const output = execFileSync("bash", [runPath, "deny.toml"], {
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
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output --config deny.toml",
		]);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output --config deny\.toml/,
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
			[runPath, "Cargo.lock", "crates/member/Cargo.toml"],
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
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output",
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path crates/member/Cargo.toml check --audit-compatible-output",
		]);
		assert.match(
			result.details,
			/error\[RUSTSEC-2024-0001\]: root 0\.1\.0 - issue in Cargo\.toml/,
		);
		assert.match(result.details, /error\[rejected\]: issue in Cargo\.toml/);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path crates\/member\/Cargo\.toml check --audit-compatible-output/,
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
		const output = execFileSync("bash", [runPath, "policies/deny.toml"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
			}),
		});
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

test("cargo-deny.sh ignores warning-only duplicate diagnostics", () => {
	const context = makeTempRepo("cargo-deny-duplicate-warning-");
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

	try {
		const output = execFileSync("bash", [runPath, "Cargo.lock"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
				DUPLICATE_WARNING_MANIFEST: "Cargo.toml",
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.equal(result.warning_count, 1);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.equal(result.cargo_deny_runs[0].exit_code, 1);
		assert.equal(result.cargo_deny_runs[0].diagnostics.length, 0);
		assert.equal(result.cargo_deny_runs[0].warning_diagnostics.length, 1);
		assert.match(
			result.details,
			/warning\[duplicate\]: found 2 duplicate entries for crate 'demo'/,
		);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config deny.toml",
		]);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh honors repo-local Cargo config while keeping workspace member runs distinct", () => {
	const context = makeTempRepo("cargo-deny-cargo-config-");
	const argsLog = path.join(context.tempDir, "cargo-deny-args.log");

	createCargoDenyStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[workspace]
members = ["crates/member", "crates/other"]
resolver = "2"
`,
	);
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		"[build]\ntarget-dir = 'target/root'\n",
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
	writeFile(
		path.join(context.repoDir, "crates/member/.cargo/config.toml"),
		"[build]\ntarget-dir = 'target/member'\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/other/Cargo.toml"),
		`[package]
name = "other"
version = "0.1.0"
edition = "2021"
`,
	);

	try {
		const output = execFileSync(
			"bash",
			[
				runPath,
				".cargo/config.toml",
				"crates/member/deny.toml",
				"crates/other/Cargo.toml",
			],
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
		assert.equal(result.cargo_deny_runs.length, 2);
		assert.deepEqual(fs.readFileSync(argsLog, "utf8").trim().split("\n"), [
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output",
			"cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo.toml check --audit-compatible-output --config crates/member/deny.toml",
		]);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output/,
		);
		assert.match(
			result.details,
			/cargo deny --format json --color never --log-level warn --all-features --manifest-path Cargo\.toml check --audit-compatible-output --config crates\/member\/deny\.toml/,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh rejects unsafe repo-local Cargo config before networked resolution", () => {
	const context = makeTempRepo("cargo-deny-unsafe-cargo-config-");
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
		path.join(context.repoDir, ".cargo/config.toml"),
		"[net]\nretry = 3\n",
	);

	try {
		const output = execFileSync("bash", [runPath, "Cargo.lock"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.match(
			result.details,
			/repo-local Cargo config for networked resolution is restricted on the shared runner\./,
		);
		assert.match(result.details, /unsupported top-level section\(s\): net/);
		assert.equal(fs.existsSync(argsLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-deny.sh rejects alias-based cargo subcommand shadowing before networked resolution", () => {
	const context = makeTempRepo("cargo-deny-unsafe-cargo-alias-");
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
		path.join(context.repoDir, ".cargo/config.toml"),
		'[alias]\ndeny = ["run", "--"]\n',
	);

	try {
		const output = execFileSync("bash", [runPath, "Cargo.lock"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CARGO_DENY_ARGS_LOG: argsLog,
			}),
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.equal(result.cargo_deny_runs.length, 1);
		assert.match(
			result.details,
			/repo-local Cargo config for networked resolution is restricted on the shared runner\./,
		);
		assert.match(result.details, /unsupported top-level section\(s\): alias/);
		assert.equal(fs.existsSync(argsLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
