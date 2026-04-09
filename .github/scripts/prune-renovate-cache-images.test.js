const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
	buildBranchCacheTag,
	buildPrCacheTag,
	pruneRenovateCacheImages,
	sanitizeCacheKeyComponent,
} = require("./prune-renovate-cache-images.js");

const repoRoot = path.join(__dirname, "..", "..");

test("cache tags are prefixed and keyed by branch or PR identity", () => {
	const baseImage =
		"docker.io/library/node:24-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c";
	const renovateVersion = "43.104.4";
	const branchName = "Feature/Renovate Cache Cleanup";
	const prNumber = "98";
	const output = execFileSync(
		"bash",
		[
			"-lc",
			[
				"set -euo pipefail",
				"source renovate/common.sh",
				`renovate_image_tags '${baseImage}' '${renovateVersion}'`,
			].join("\n"),
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				RENOVATE_CACHE_BRANCH_NAME: branchName,
				RENOVATE_CACHE_PR_NUMBER: prNumber,
				RENOVATE_CACHE_SOURCE_HEAD_SHA:
					"ecab9744f53cbd3cf30b1e72f34ba12503c1bf77",
			},
		},
	)
		.trim()
		.split(/\r?\n/u);

	assert.deepEqual(output, [
		buildPrCacheTag({
			baseImage,
			prNumber,
			renovateVersion,
		}),
		buildBranchCacheTag({
			baseImage,
			branchName,
			renovateVersion,
		}),
	]);
	assert.ok(output.every((tag) => tag.startsWith("cache-")));
});

test("branch cache keys stay compact and deterministic", () => {
	const branchName =
		"feature/THIS-IS-A-VERY-LONG-BRANCH-NAME/with/Many/Segments/and.EXTRA_characters";
	const sanitized = sanitizeCacheKeyComponent(branchName);

	assert.match(sanitized, /^[a-z0-9][a-z0-9._-]*$/u);
	assert.ok(sanitized.length <= 48);
	assert.equal(sanitizeCacheKeyComponent(branchName), sanitized);
});

test("prunes package versions that are not kept by active branch or PR cache tags", async () => {
	const repository = "chalharu/linter-service";
	const baseImage =
		"docker.io/library/node:24-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c";
	const renovateVersion = "43.104.4";
	const mainTag = buildBranchCacheTag({
		baseImage,
		branchName: "main",
		renovateVersion,
	});
	const featureTag = buildBranchCacheTag({
		baseImage,
		branchName: "copilot/add-renovate-shared-linter",
		renovateVersion,
	});
	const prTag = buildPrCacheTag({
		baseImage,
		prNumber: "98",
		renovateVersion,
	});
	const dockerfilePayload = makeContentsPayload(
		[
			"# renovate: datasource=docker depName=library/node versioning=docker",
			`ARG RENOVATE_BASE_IMAGE=${baseImage}`,
			"FROM ${RENOVATE_BASE_IMAGE}",
			"",
		].join("\n"),
	);
	const installPayload = makeContentsPayload(
		[
			"#!/usr/bin/env bash",
			"# renovate: datasource=npm depName=renovate",
			`renovate_version="${renovateVersion}"`,
			"",
		].join("\n"),
	);
	const deleteCalls = [];
	const responses = new Map([
		[
			"GET https://api.github.com/repos/chalharu/linter-service",
			jsonResponse({
				owner: {
					login: "chalharu",
					type: "User",
				},
			}),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/branches?per_page=100&page=1",
			jsonResponse([
				{ commit: { sha: "mainsha" }, name: "main" },
				{
					commit: { sha: "featuresha" },
					name: "copilot/add-renovate-shared-linter",
				},
			]),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/pulls?state=open&per_page=100&page=1",
			jsonResponse([{ number: 98 }]),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/Dockerfile?ref=mainsha",
			jsonResponse(dockerfilePayload),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/install.sh?ref=mainsha",
			jsonResponse(installPayload),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/Dockerfile?ref=featuresha",
			jsonResponse(dockerfilePayload),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/install.sh?ref=featuresha",
			jsonResponse(installPayload),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/Dockerfile?ref=refs%2Fpull%2F98%2Fhead",
			jsonResponse(dockerfilePayload),
		],
		[
			"GET https://api.github.com/repos/chalharu/linter-service/contents/renovate/install.sh?ref=refs%2Fpull%2F98%2Fhead",
			jsonResponse(installPayload),
		],
		[
			"GET https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions?per_page=100&page=1",
			jsonResponse([
				{ id: 1, metadata: { container: { tags: [mainTag] } } },
				{ id: 2, metadata: { container: { tags: [featureTag] } } },
				{ id: 3, metadata: { container: { tags: [prTag] } } },
				{
					id: 4,
					metadata: {
						container: {
							tags: [
								"cache-branch-old-feature-renovate-43.104.4-base-deadbeefcafe",
							],
						},
					},
				},
				{
					id: 5,
					metadata: {
						container: {
							tags: ["renovate-43.104.4-base-deadbeefcafe"],
						},
					},
				},
				{ id: 6, metadata: { container: { tags: [] } } },
			]),
		],
		[
			"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/4",
			noContentResponse(),
		],
		[
			"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/5",
			noContentResponse(),
		],
		[
			"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/6",
			noContentResponse(),
		],
	]);
	const outcome = await pruneRenovateCacheImages({
		env: {
			GITHUB_REPOSITORY: repository,
			GITHUB_REPOSITORY_OWNER: "chalharu",
			GH_TOKEN: "token",
			RENOVATE_IMAGE_REPOSITORY: "ghcr.io/chalharu/linter-service-renovate",
		},
		fetchImpl: async (url, options = {}) => {
			const key = `${options.method || "GET"} ${url}`;
			const response = responses.get(key);

			if (!response) {
				throw new Error(`Unexpected request: ${key}`);
			}

			if ((options.method || "GET") === "DELETE") {
				deleteCalls.push(key);
			}

			return response;
		},
		consoleImpl: {
			log() {},
			warn() {},
		},
	});

	assert.deepEqual(outcome.deletedVersionIds, ["4", "5", "6"]);
	assert.deepEqual(deleteCalls, [
		"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/4",
		"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/5",
		"DELETE https://api.github.com/users/chalharu/packages/container/linter-service-renovate/versions/6",
	]);
	assert.deepEqual(outcome.keepTags, [featureTag, mainTag, prTag].sort());
});

function makeContentsPayload(source) {
	return {
		content: Buffer.from(source, "utf8").toString("base64"),
		encoding: "base64",
	};
}

function jsonResponse(payload, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return payload;
		},
	};
}

function noContentResponse(status = 204) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return {};
		},
	};
}
