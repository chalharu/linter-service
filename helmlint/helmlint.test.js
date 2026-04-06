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

function createReleaseAsset(assetPath) {
	const assetRoot = path.join(path.dirname(assetPath), "asset");
	const helmDir = path.join(assetRoot, "linux-amd64");

	fs.mkdirSync(helmDir, { recursive: true });
	writeExecutable(
		path.join(helmDir, "helm"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "version" ]; then
  echo "v0.0.0"
  exit 0
fi
exit 0
`,
	);
	execFileSync("tar", ["-czf", assetPath, "-C", assetRoot, "linux-amd64"]);
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
cp "$HELM_ASSET_SOURCE" "$out_file"
`,
	);
}

function createHelmStub(binDir) {
	writeExecutable(
		path.join(binDir, "helm"),
		`#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "version" ]; then
  echo "v3.20.1"
  exit 0
fi
if [ "$1" != "lint" ]; then
  echo "unsupported helm command: $1" >&2
  exit 1
fi
shift
chart_path="$1"
printf '%s\\n' "$chart_path" >> "$HELM_ARGS_LOG"
printf 'linted %s\\n' "$chart_path"
if [ -n "\${FAIL_CHART:-}" ] && [ "$chart_path" = "$FAIL_CHART" ]; then
  printf '%s/templates/configmap.yaml:4:3: chart failed\\n' "$chart_path" >&2
  exit 1
fi
`,
	);
}

test("helmlint.sh patterns match Helm chart files", () => {
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

	assert.equal(matches("Chart.yaml"), true);
	assert.equal(matches("charts/demo/Chart.lock"), true);
	assert.equal(matches("charts/demo/values.yaml"), true);
	assert.equal(matches("charts/demo/values.prod.yml"), true);
	assert.equal(matches("charts/demo/values.schema.json"), true);
	assert.equal(matches("charts/demo/templates/configmap.yaml"), true);
	assert.equal(matches("charts/demo/templates/_helpers.tpl"), true);
	assert.equal(matches("charts/demo/charts/subchart-1.0.0.tgz"), true);
	assert.equal(matches("docs/chart-guide.md"), false);
	assert.equal(matches("docs/values.yaml"), true);
});

test("helmlint.sh install downloads the pinned Helm archive", () => {
	const context = makeTempRepo("helmlint-install-");
	const curlUrlLog = path.join(context.tempDir, "curl-urls.log");
	const version = readPinnedVersion(installPath, "helm_version");
	const assetPath = path.join(
		context.tempDir,
		`helm-${version}-linux-amd64.tar.gz`,
	);

	createReleaseAsset(assetPath);
	createCurlStub(context.binDir);

	try {
		execFileSync("bash", [installPath], {
			cwd: context.repoDir,
			encoding: "utf8",
			env: createEnv(context, {
				CURL_URL_LOG: curlUrlLog,
				HELM_ASSET_SOURCE: assetPath,
			}),
		});

		assert.deepEqual(fs.readFileSync(curlUrlLog, "utf8").trim().split("\n"), [
			`https://get.helm.sh/helm-${version}-linux-amd64.tar.gz`,
		]);
		assert.equal(
			fs.existsSync(path.join(context.runnerTemp, "helmlint/bin/helm")),
			true,
		);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("helmlint.sh deduplicates chart roots and ignores files outside charts", () => {
	const context = makeTempRepo("helmlint-run-");
	const helmArgsLog = path.join(context.tempDir, "helm-args.log");

	createHelmStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "charts/app/Chart.yaml"),
		"apiVersion: v2\nname: app\nversion: 0.1.0\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/app/values.yaml"),
		"replicaCount: 1\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/app/templates/configmap.yaml"),
		"apiVersion: v1\nkind: ConfigMap\n",
	);
	writeFile(path.join(context.repoDir, "docs/values.yaml"), "title: docs\n");

	try {
		const output = execFileSync(
			"bash",
			[
				runPath,
				"charts/app/values.yaml",
				"docs/values.yaml",
				"charts/app/templates/configmap.yaml",
				"charts/app/Chart.yaml",
			],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					HELM_ARGS_LOG: helmArgsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 0);
		assert.deepEqual(fs.readFileSync(helmArgsLog, "utf8").trim().split("\n"), [
			"charts/app",
		]);
		assert.match(result.details, /==> helm lint charts\/app/);
		assert.match(result.details, /linted charts\/app/);
		assert.doesNotMatch(result.details, /docs\/values\.yaml/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});

test("helmlint.sh continues linting later charts after one failure", () => {
	const context = makeTempRepo("helmlint-run-failure-");
	const helmArgsLog = path.join(context.tempDir, "helm-args.log");

	createHelmStub(context.binDir);
	writeFile(
		path.join(context.repoDir, "charts/app/Chart.yaml"),
		"apiVersion: v2\nname: app\nversion: 0.1.0\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/app/values.yaml"),
		"replicaCount: 1\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/worker/Chart.yaml"),
		"apiVersion: v2\nname: worker\nversion: 0.1.0\n",
	);
	writeFile(
		path.join(context.repoDir, "charts/worker/templates/configmap.yaml"),
		"apiVersion: v1\nkind: ConfigMap\n",
	);

	try {
		const output = execFileSync(
			"bash",
			[
				runPath,
				"charts/app/values.yaml",
				"charts/worker/templates/configmap.yaml",
			],
			{
				cwd: context.repoDir,
				encoding: "utf8",
				env: createEnv(context, {
					FAIL_CHART: "charts/app",
					HELM_ARGS_LOG: helmArgsLog,
				}),
			},
		);
		const result = JSON.parse(output);

		assert.equal(result.exit_code, 1);
		assert.deepEqual(fs.readFileSync(helmArgsLog, "utf8").trim().split("\n"), [
			"charts/app",
			"charts/worker",
		]);
		assert.match(result.details, /chart failed/);
		assert.match(result.details, /linted charts\/worker/);
	} finally {
		cleanupTempRepo(context.tempDir);
	}
});
