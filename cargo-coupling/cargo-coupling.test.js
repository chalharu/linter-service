const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
	assert,
	cleanupTempRepo,
	defineCommonCargoManifestTests,
	fs,
	makeTempRepo,
	path,
	writeExecutable,
	writeFile,
} = require("../.github/scripts/cargo-linter-test-lib.js");

const installPath = path.join(__dirname, "install.sh");
const commonPath = path.join(__dirname, "common.sh");
const runPath = path.join(__dirname, "run.sh");
const cargoCouplingVersion = readInstallAssignment("cargo_coupling_version");
const cargoCouplingSemver = cargoCouplingVersion.replace(/^v/u, "");

function readInstallAssignment(variableName) {
	const source = fs.readFileSync(installPath, "utf8");
	const match = source.match(
		new RegExp(`^${variableName}="([^"\\n]+)"$`, "mu"),
	);

	if (!match) {
		throw new Error(`failed to read ${variableName} from ${installPath}`);
	}

	return match[1];
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function createDockerStub(binDir) {
	writeExecutable(
		path.join(binDir, "docker"),
		`#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift

case "$command" in
  image)
    subcommand="$1"
    shift
    if [ "$subcommand" != "inspect" ]; then
      echo "unsupported docker image subcommand: $subcommand" >&2
      exit 1
    fi
    printf '%s\\n' "$*" >> "$DOCKER_IMAGE_INSPECT_LOG"
    if [ -n "\${MISSING_IMAGE:-}" ]; then
      exit 1
    fi
    ;;
  pull)
    printf '%s\\n' "$*" >> "$DOCKER_PULL_LOG"
    ;;
  build)
    printf '%s\\n' "$*" >> "$DOCKER_BUILD_LOG"
    ;;
  run)
    work_mount_src=""
    cargo_home_mount_src=""
    rustup_mount_src=""
    container_workdir="/work"
    entrypoint=""
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
              *"dst=/cargo-home"*|*"target=/cargo-home"*)
                cargo_home_mount_src="\${arg#*src=}"
                cargo_home_mount_src="\${cargo_home_mount_src%%,*}"
                ;;
              *"dst=/rustup-home"*|*"target=/rustup-home"*|*"dst=/usr/local/rustup"*|*"target=/usr/local/rustup"*)
                rustup_mount_src="\${arg#*src=}"
                rustup_mount_src="\${rustup_mount_src%%,*}"
                ;;
            esac
            ;;
          --workdir)
            container_workdir="$arg"
            ;;
          --entrypoint)
            entrypoint="$arg"
            ;;
        esac
        option_with_value=""
        continue
      fi
      case "$arg" in
        --mount|--user|--workdir|--tmpfs|--security-opt|--cap-drop|--env|-e|--entrypoint)
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
    if [ -n "$entrypoint" ]; then
      command_args=("$entrypoint" "\${command_args[@]}")
    fi
    printf '%s\\n' "$*" >> "$DOCKER_RUN_ARGS_LOG"

    if [ "\${command_args[0]-}" = "sh" ] && [ "\${command_args[1]-}" = "-ceu" ]; then
      if [ -n "$rustup_mount_src" ]; then
        mkdir -p "$rustup_mount_src"
        cat <<'EOF' > "$rustup_mount_src/settings.toml"
version = "12"
default_toolchain = "stable-x86_64-unknown-linux-gnu"
profile = "minimal"
EOF
      fi
      exit 0
    fi

    host_workdir="$work_mount_src"
    if [ "$container_workdir" != "/work" ]; then
      host_workdir="$work_mount_src/\${container_workdir#/work/}"
    fi

    if [ -z "$work_mount_src" ]; then
      echo "missing work mount" >&2
      exit 1
    fi

    if [ "\${command_args[0]-}" = "cargo" ] && [ "\${command_args[1]-}" = "metadata" ]; then
      manifest=""
      index=0
      while [ "$index" -lt "\${#command_args[@]}" ]; do
        if [ "\${command_args[$index]}" = "--manifest-path" ]; then
          manifest="\${command_args[$((index + 1))]}"
          break
        fi
        index=$((index + 1))
      done
      if [ -z "$manifest" ]; then
        echo "missing metadata manifest" >&2
        exit 1
      fi

      manifest_path=$(/usr/bin/python3 - "$host_workdir" "$manifest" <<'PY'
import os
import sys
print(os.path.normpath(os.path.join(sys.argv[1], sys.argv[2])))
PY
      )
      workspace_dir=$(dirname "$manifest_path")
      search_dir="$workspace_dir"
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

    if [ "\${command_args[0]-}" = "cargo" ] && [ "\${command_args[1]-}" = "fetch" ]; then
      manifest=""
      index=0
      while [ "$index" -lt "\${#command_args[@]}" ]; do
        if [ "\${command_args[$index]}" = "--manifest-path" ]; then
          manifest="\${command_args[$((index + 1))]}"
          break
        fi
        index=$((index + 1))
      done
      if [ -z "$manifest" ]; then
        echo "missing fetch manifest" >&2
        exit 1
      fi

      printf '%s\\n' "$manifest" >> "$DOCKER_FETCH_MANIFEST_LOG"
      if [ -n "$cargo_home_mount_src" ]; then
        mkdir -p "$cargo_home_mount_src/registry/cache"
        printf 'cached %s\\n' "$manifest" > "$cargo_home_mount_src/registry/cache/\${manifest//\\//_}.txt"
      fi
      if [ -n "\${FAIL_FETCH_MANIFEST:-}" ] && [ "$manifest" = "$FAIL_FETCH_MANIFEST" ]; then
        echo "fetch failed for $manifest" >&2
        exit 1
      fi
      exit 0
    fi

    analysis_path="\${command_args[-1]}"
    analysis_root="$host_workdir/$analysis_path"
    if [ -f "$analysis_root" ]; then
      search_dir=$(dirname "$analysis_root")
    else
      search_dir="$analysis_root"
    fi
    while :; do
      candidate="$search_dir/Cargo.toml"
      if [ -f "$candidate" ]; then
        manifest_path="$candidate"
        break
      fi
      if [ "$search_dir" = "$work_mount_src" ] || [ "$search_dir" = "/" ]; then
        echo "missing Cargo.toml" >&2
        exit 1
      fi
      search_dir=$(dirname "$search_dir")
    done

    manifest_rel=$(/usr/bin/python3 - "$work_mount_src" "$manifest_path" <<'PY'
import os
import sys
print(os.path.relpath(sys.argv[2], sys.argv[1]).replace(os.sep, "/"))
PY
)
    printf '%s\\n' "$manifest_rel" >> "$DOCKER_MANIFEST_LOG"
    if [ -e "$work_mount_src/.git" ]; then
      printf 'present\\n' >> "$WORKTREE_GIT_LOG"
    else
      printf 'absent\\n' >> "$WORKTREE_GIT_LOG"
    fi

    if [ -n "\${FAIL_MANIFEST:-}" ] && [ "$manifest_rel" = "$FAIL_MANIFEST" ]; then
      echo "cargo-coupling failed for $manifest_rel" >&2
      exit 1
    fi

    package_name=$(/usr/bin/python3 - "$manifest_path" <<'PY'
import sys
name = ""
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("name = "):
        name = line.split("=", 1)[1].strip().strip('"')
        break
print(name)
PY
)
    if [ -n "\${COUPLING_RELAXED:-}" ]; then
      cat <<'JSON'
{
  "summary": {
    "health_grade": "C",
    "health_score": 0.73,
    "total_modules": 2,
    "total_couplings": 1,
    "internal_couplings": 1,
    "external_couplings": 0,
    "critical_issues": 1,
    "high_issues": 0,
    "medium_issues": 0
  },
  "hotspots": [],
  "issues": [],
  "circular_dependencies": [
    ["crate::a", "crate::b", "crate::a"]
  ],
  "modules": []
}
JSON
      exit 0
    fi
    if [[ "$package_name" == *fail* ]]; then
      cat <<'JSON'
{
  "summary": {
    "health_grade": "C",
    "health_score": 0.62,
    "total_modules": 2,
    "total_couplings": 2,
    "internal_couplings": 2,
    "external_couplings": 0,
    "critical_issues": 1,
    "high_issues": 0,
    "medium_issues": 1
  },
  "hotspots": [],
  "issues": [
    {
      "issue_type": "Global Complexity",
      "severity": "Critical",
      "source": "fixture_fail::handler",
      "target": "fixture_fail::query",
      "description": "Intrusive coupling across a distant module boundary",
      "suggestion": "Introduce a trait boundary between handler and query.",
      "balance_score": 0.24
    },
    {
      "issue_type": "High Afferent Coupling",
      "severity": "Medium",
      "source": "fixture_fail::handler",
      "target": "",
      "description": "Module attracts many internal dependencies",
      "suggestion": "Split responsibilities or hide internals behind a smaller API.",
      "balance_score": 0.49
    }
  ],
  "circular_dependencies": [
    ["fixture_fail::handler", "fixture_fail::query", "fixture_fail::handler"]
  ],
  "modules": [
    {
      "name": "fixture_fail::handler",
      "file_path": "src/lib.rs",
      "couplings_out": 1,
      "couplings_in": 1,
      "balance_score": 0.24,
      "in_cycle": true
    },
    {
      "name": "fixture_fail::query",
      "file_path": "src/lib.rs",
      "couplings_out": 1,
      "couplings_in": 1,
      "balance_score": 0.49,
      "in_cycle": true
    }
  ]
}
JSON
      exit 0
    fi
    cat <<'JSON'
{
  "summary": {
    "health_grade": "B",
    "health_score": 0.91,
    "total_modules": 1,
    "total_couplings": 1,
    "internal_couplings": 1,
    "external_couplings": 0,
    "critical_issues": 0,
    "high_issues": 0,
    "medium_issues": 0
  },
  "hotspots": [],
  "issues": [],
  "circular_dependencies": [],
  "modules": [
    {
      "name": "fixture_pass::service",
      "file_path": "src/lib.rs",
      "couplings_out": 1,
      "couplings_in": 0,
      "balance_score": 0.91,
      "in_cycle": false
    }
  ]
}
JSON
    ;;
  *)
    echo "unsupported docker command: $command" >&2
    exit 1
    ;;
esac
`,
	);
}

function createCargoCouplingSourceArchive(context) {
	const sourceRoot = path.join(context.tempDir, "cargo-coupling-source");
	const archiveRoot = path.join(sourceRoot, "cargo-coupling-src");
	const archivePath = path.join(
		context.tempDir,
		"cargo-coupling-source.tar.gz",
	);

	writeFile(
		path.join(archiveRoot, "Cargo.toml"),
		`[package]
name = "cargo-coupling"
version = "${cargoCouplingSemver}"
edition = "2021"
`,
	);
	writeFile(path.join(archiveRoot, "src/main.rs"), "fn main() {}\n");
	execFileSync(
		"tar",
		[
			"--sort=name",
			"--mtime=@0",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"-czf",
			archivePath,
			"-C",
			sourceRoot,
			"cargo-coupling-src",
		],
		{ encoding: "utf8" },
	);

	return {
		archivePath,
	};
}

function createCurlStub(binDir) {
	writeExecutable(
		path.join(binDir, "curl"),
		`#!/usr/bin/env bash
set -euo pipefail
output_path=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_path="$2"
      shift 2
      ;;
    -f|-s|-S|-L|-fsSL)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

if [ -z "$output_path" ]; then
  echo "missing curl output path" >&2
  exit 1
fi

printf '%s\\n' "$url" >> "$CURL_LOG"
if [ -z "\${STUB_CARGO_COUPLING_ARCHIVE:-}" ]; then
  echo "missing STUB_CARGO_COUPLING_ARCHIVE" >&2
  exit 1
fi
cp "$STUB_CARGO_COUPLING_ARCHIVE" "$output_path"
`,
	);
}

function setupTooling(context) {
	const cargoCouplingSourceArchive = createCargoCouplingSourceArchive(context);

	writeFile(path.join(context.repoDir, ".git/HEAD"), "ref: refs/heads/test\n");
	createCargoStub(context.binDir);
	createCurlStub(context.binDir);
	createDockerStub(context.binDir);

	const tooling = {
		cargoCouplingSourceArchivePath: cargoCouplingSourceArchive.archivePath,
		curlLog: path.join(context.tempDir, "curl.log"),
		dockerBuildLog: path.join(context.tempDir, "docker-build.log"),
		dockerFetchManifestLog: path.join(
			context.tempDir,
			"docker-fetch-manifests.log",
		),
		dockerImageInspectLog: path.join(
			context.tempDir,
			"docker-image-inspect.log",
		),
		dockerManifestLog: path.join(context.tempDir, "docker-manifests.log"),
		dockerPullLog: path.join(context.tempDir, "docker-pull.log"),
		dockerRunArgsLog: path.join(context.tempDir, "docker-run-args.log"),
		worktreeGitLog: path.join(context.tempDir, "worktree-git.log"),
	};

	return {
		...tooling,
		env: {
			CURL_LOG: tooling.curlLog,
			DOCKER_BUILD_LOG: tooling.dockerBuildLog,
			DOCKER_FETCH_MANIFEST_LOG: tooling.dockerFetchManifestLog,
			DOCKER_IMAGE_INSPECT_LOG: tooling.dockerImageInspectLog,
			DOCKER_MANIFEST_LOG: tooling.dockerManifestLog,
			DOCKER_PULL_LOG: tooling.dockerPullLog,
			DOCKER_RUN_ARGS_LOG: tooling.dockerRunArgsLog,
			STUB_CARGO_COUPLING_ARCHIVE: cargoCouplingSourceArchive.archivePath,
			WORKTREE_GIT_LOG: tooling.worktreeGitLog,
		},
	};
}

test("cargo-coupling install builds the pinned local container image when missing", () => {
	const context = makeTempRepo("cargo-coupling-install-");
	const tooling = setupTooling(context);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				MISSING_IMAGE: "1",
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});

		assert.match(
			fs.readFileSync(tooling.dockerImageInspectLog, "utf8"),
			new RegExp(
				`localhost/linter-service-cargo-coupling:${escapeRegExp(cargoCouplingSemver)}-[a-f0-9]{12}`,
				"u",
			),
		);
		assert.match(
			fs.readFileSync(tooling.curlLog, "utf8"),
			new RegExp(
				`github\\.com/nwiizo/cargo-coupling/archive/refs/tags/${escapeRegExp(cargoCouplingVersion)}\\.tar\\.gz`,
				"u",
			),
		);
		assert.match(
			fs.readFileSync(tooling.dockerBuildLog, "utf8"),
			new RegExp(
				`--tag localhost/linter-service-cargo-coupling:${escapeRegExp(cargoCouplingSemver)}-[a-f0-9]{12}`,
				"u",
			),
		);
		assert.match(
			fs.readFileSync(tooling.dockerBuildLog, "utf8"),
			/--file .*cargo-coupling-image\/source\/Dockerfile\.full .*cargo-coupling-image\/source/,
		);
		assert.equal(fs.existsSync(tooling.dockerPullLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-coupling image ref changes when build inputs change", () => {
	const defaultEnv = {
		...process.env,
		CARGO_COUPLING_VERSION: cargoCouplingVersion,
	};
	const alternateEnv = {
		...defaultEnv,
		CARGO_COUPLING_VERSION: "v9.9.9",
	};
	const defaultImageRef = execFileSync(
		"bash",
		["-lc", `source "${commonPath}" && cargo_coupling_image_ref`],
		{
			cwd: __dirname,
			encoding: "utf8",
			env: defaultEnv,
		},
	).trim();
	const alternateImageRef = execFileSync(
		"bash",
		["-lc", `source "${commonPath}" && cargo_coupling_image_ref`],
		{
			cwd: __dirname,
			encoding: "utf8",
			env: alternateEnv,
		},
	).trim();

	assert.notEqual(defaultImageRef, alternateImageRef);
	assert.match(
		defaultImageRef,
		new RegExp(
			`^localhost/linter-service-cargo-coupling:${escapeRegExp(cargoCouplingSemver)}-[a-f0-9]{12}$`,
			"u",
		),
	);
});

test("cargo-coupling install does not require a source archive checksum override", () => {
	const context = makeTempRepo("cargo-coupling-install-no-checksum-");
	const tooling = setupTooling(context);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				MISSING_IMAGE: "1",
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		assert.match(
			fs.readFileSync(tooling.dockerBuildLog, "utf8"),
			new RegExp(
				`--tag localhost/linter-service-cargo-coupling:${escapeRegExp(cargoCouplingSemver)}-[a-f0-9]{12}`,
				"u",
			),
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

defineCommonCargoManifestTests({
	runPath,
	tempPrefix: "cargo-coupling-",
	toolName: "cargo-coupling.sh",
	setupTooling,
	assertGroupedResult({ result, tooling }) {
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["Cargo.toml", "Cargo.toml"],
		);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["Cargo.toml", "crates/member/Cargo.toml"],
		);
		assert.match(runArgs, /--network=none/);
		assert.match(runArgs, /--read-only/);
		assert.match(runArgs, /--tmpfs \/tmp/);
		assert.match(
			runArgs,
			/--network=none --entrypoint cargo [^\n]*metadata --format-version 1 --no-deps --manifest-path Cargo\.toml/,
		);
		assert.match(
			runArgs,
			/--entrypoint cargo [^\n]*fetch --manifest-path Cargo\.toml/,
		);
		assert.match(runArgs, /--entrypoint cargo/);
		assert.match(runArgs, /--entrypoint sh/);
		assert.match(runArgs, /dst=\/cargo-home/);
		assert.match(runArgs, /dst=\/usr\/local\/rustup/);
		assert.match(runArgs, /CARGO_HOME=\/cargo-home/);
		assert.match(runArgs, /HOME=\/cargo-home/);
		assert.match(runArgs, /CARGO_NET_OFFLINE=true/);
		assert.doesNotMatch(runArgs, /dst=\/work,ro/);
		assert.match(runArgs, /coupling --json --no-git src/);
		assert.match(runArgs, /--workdir \/work\/crates\/member/);
		assert.deepEqual(
			fs.readFileSync(tooling.worktreeGitLog, "utf8").trim().split("\n"),
			["absent", "absent"],
		);
		assert.match(result.details, /Quality gate: PASSED/);
	},
	assertMissingManifestResult({ pathValue, result, tooling }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /No Cargo\.toml found for:/);
		assert.match(
			result.details,
			new RegExp(pathValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.equal(fs.existsSync(tooling.dockerFetchManifestLog), false);
		assert.equal(fs.existsSync(tooling.dockerRunArgsLog), false);
	},
	continueFailureEnv: {
		FAIL_MANIFEST: "Cargo.toml",
	},
	assertContinueAfterFailureResult({ result }) {
		assert.equal(result.exit_code, 1);
		assert.match(result.details, /cargo-coupling failed for Cargo\.toml/);
	},
});

test("cargo-coupling runs from the manifest scope so member-local Cargo config is honored", () => {
	const context = makeTempRepo("cargo-coupling-cargo-config-");
	const tooling = setupTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[workspace]
members = ["crates/member"]
resolver = "2"
`,
	);
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		`[build]
target-dir = "target/root"
`,
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
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);
	writeFile(
		path.join(context.repoDir, "crates/member/.cargo/config.toml"),
		`[build]
target-dir = "target/member"
`,
	);

	try {
		const output = execFileSync("bash", [runPath, "crates/member/src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["../../Cargo.toml"],
		);
		assert.match(runArgs, /--workdir \/work\/crates\/member/);
		assert.match(
			runArgs,
			/--workdir \/work\/crates\/member [^\n]*fetch --manifest-path \.\.\/\.\.\/Cargo\.toml/,
		);
		assert.match(runArgs, /coupling --json --no-git src/);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-coupling reads repository thresholds from linter-service config", () => {
	const context = makeTempRepo("cargo-coupling-config-");
	const tooling = setupTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, ".github/linter-service.yaml"),
		[
			"linters:",
			"  cargo-coupling:",
			"    min_grade: C",
			"    max_critical: 1",
			"    max_circular: 1",
			"",
		].join("\n"),
	);

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				COUPLING_RELAXED: "1",
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.match(
			result.details,
			/Thresholds: min_grade=C, max_critical=1, max_circular=1/,
		);
		assert.match(result.details, /Quality gate: PASSED/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-coupling keeps member crate analysis scoped to the selected package in workspaces", () => {
	const context = makeTempRepo("cargo-coupling-workspace-member-");
	const tooling = setupTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "workspace-root"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["crates/member"]
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync("bash", [runPath, "crates/member/src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);
		const runArgs = fs.readFileSync(tooling.dockerRunArgsLog, "utf8");

		assert.equal(result.exit_code, 0);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["../../Cargo.toml"],
		);
		assert.doesNotMatch(runArgs, /dst=\/work,ro/u);
		assert.match(
			runArgs,
			/--workdir \/work\/crates\/member [^\n]*fetch --manifest-path \.\.\/\.\.\/Cargo\.toml/u,
		);
		assert.match(runArgs, /--workdir \/work\/crates\/member/u);
		assert.match(runArgs, /coupling --json --no-git src/u);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-coupling skips only the manifest whose cargo fetch fails and continues later runs", () => {
	const context = makeTempRepo("cargo-coupling-fetch-failure-");
	const tooling = setupTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["crates/member"]
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, "crates/member/Cargo.toml"),
		`[package]
name = "member"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(
		path.join(context.repoDir, "crates/member/src/lib.rs"),
		"pub fn member_lib() {}\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[runPath, "src/lib.rs", "crates/member/src/lib.rs"],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: {
					...process.env,
					...tooling.env,
					FAIL_FETCH_MANIFEST: "Cargo.toml",
					PATH: `${context.binDir}:${process.env.PATH}`,
					RUNNER_TEMP: context.runnerTemp,
				},
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(result.details, /fetch failed for Cargo\.toml/u);
		assert.match(
			result.details,
			/skip cargo-coupling --manifest-path Cargo\.toml because cargo fetch failed/u,
		);
		assert.deepEqual(
			fs
				.readFileSync(tooling.dockerFetchManifestLog, "utf8")
				.trim()
				.split("\n"),
			["Cargo.toml", "../../Cargo.toml"],
		);
		assert.deepEqual(
			fs.readFileSync(tooling.dockerManifestLog, "utf8").trim().split("\n"),
			["crates/member/Cargo.toml"],
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("cargo-coupling rejects unsafe repo-local Cargo config before cargo fetch", () => {
	const context = makeTempRepo("cargo-coupling-unsafe-config-");
	const tooling = setupTooling(context);

	writeFile(
		path.join(context.repoDir, "Cargo.toml"),
		`[package]
name = "root"
version = "0.1.0"
edition = "2021"
`,
	);
	writeFile(path.join(context.repoDir, "src/lib.rs"), "pub fn root_lib() {}\n");
	writeFile(
		path.join(context.repoDir, ".cargo/config.toml"),
		`[registries.crates-io]
protocol = "sparse"
`,
	);

	try {
		const output = execFileSync("bash", [runPath, "src/lib.rs"], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: {
				...process.env,
				...tooling.env,
				PATH: `${context.binDir}:${process.env.PATH}`,
				RUNNER_TEMP: context.runnerTemp,
			},
		});
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.match(
			result.details,
			/reject cargo fetch --manifest-path Cargo\.toml/u,
		);
		assert.match(
			result.details,
			/skip cargo-coupling --manifest-path Cargo\.toml because cargo fetch safety checks failed/u,
		);
		assert.equal(fs.existsSync(tooling.dockerFetchManifestLog), false);
		assert.equal(fs.existsSync(tooling.dockerManifestLog), false);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
