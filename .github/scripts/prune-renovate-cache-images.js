const { createHash } = require("node:crypto");
const requireEnv = require("./lib/require-env.js");

async function pruneRenovateCacheImages({
	env = process.env,
	fetchImpl = global.fetch,
	consoleImpl = console,
} = {}) {
	const repository = requireEnv(env, "GITHUB_REPOSITORY");
	const token = readGitHubToken(env);

	if (token.length === 0) {
		consoleImpl.warn(
			"Skipping Renovate cache image pruning because no GitHub token was provided.",
		);
		return {
			deleted: 0,
			deletedVersionIds: [],
			keepTags: [],
			skipped: true,
		};
	}

	const imageRepository =
		env.RENOVATE_IMAGE_REPOSITORY || defaultImageRepositoryFromEnv(env);
	const parsedImageRepository = parseImageRepository(imageRepository);

	if (parsedImageRepository.registry !== "ghcr.io") {
		consoleImpl.warn(
			`Skipping Renovate cache image pruning for unsupported registry ${parsedImageRepository.registry}.`,
		);
		return {
			deleted: 0,
			deletedVersionIds: [],
			keepTags: [],
			skipped: true,
		};
	}

	const { owner: repoOwner, repo } = splitRepository(repository);
	const repoInfo = await requestJson(
		fetchImpl,
		token,
		`/repos/${repoOwner}/${repo}`,
	);
	const packageOwnerType = await resolvePackageOwnerType({
		fetchImpl,
		packageOwner: parsedImageRepository.owner,
		repoInfo,
		token,
	});
	const keepTags = await collectKeepTags({
		fetchImpl,
		repo,
		repoOwner,
		token,
	});

	if (keepTags.size === 0) {
		consoleImpl.warn(
			"Skipping Renovate cache image pruning because no active cache tags could be resolved.",
		);
		return {
			deleted: 0,
			deletedVersionIds: [],
			keepTags: [],
			skipped: true,
		};
	}

	let packageVersions;

	try {
		packageVersions = await listPaginated(
			fetchImpl,
			token,
			buildPackageVersionsPath({
				owner: parsedImageRepository.owner,
				ownerType: packageOwnerType,
				packageName: parsedImageRepository.packageName,
			}),
		);
	} catch (error) {
		if (error?.status === 404) {
			consoleImpl.warn(
				`No GHCR package versions were found for ${parsedImageRepository.owner}/${parsedImageRepository.packageName}.`,
			);
			return {
				deleted: 0,
				deletedVersionIds: [],
				keepTags: [...keepTags].sort(),
				skipped: true,
			};
		}

		throw error;
	}

	const deletedVersionIds = [];

	for (const version of packageVersions) {
		const versionId = normalizePackageVersionId(version?.id);
		const tags = readPackageVersionTags(version);

		if (versionId === null) {
			continue;
		}

		if (tags.some((tag) => keepTags.has(tag))) {
			continue;
		}

		await request(fetchImpl, token, {
			method: "DELETE",
			path: `${buildPackageVersionsPath({
				owner: parsedImageRepository.owner,
				ownerType: packageOwnerType,
				packageName: parsedImageRepository.packageName,
			})}/${encodeURIComponent(versionId)}`,
		});
		deletedVersionIds.push(versionId);
	}

	consoleImpl.log(
		`Pruned ${deletedVersionIds.length} stale Renovate cache image version(s).`,
	);

	return {
		deleted: deletedVersionIds.length,
		deletedVersionIds,
		keepTags: [...keepTags].sort(),
		skipped: false,
	};
}

function defaultImageRepositoryFromEnv(env) {
	const repository = requireEnv(env, "GITHUB_REPOSITORY");
	const owner = env.GITHUB_REPOSITORY_OWNER || repository.split("/", 1)[0];
	const repo = repository.split("/", 2)[1];

	return `ghcr.io/${owner}/${repo}-renovate`;
}

function splitRepository(repository) {
	const [owner, repo] = repository.split("/", 2);

	if (!owner || !repo) {
		throw new Error(
			`GITHUB_REPOSITORY must be owner/repo, received: ${repository}`,
		);
	}

	return { owner, repo };
}

function parseImageRepository(imageRepository) {
	const normalized = String(imageRepository || "")
		.replace(/^https?:\/\//u, "")
		.replace(/\/+$/u, "")
		.split("@", 1)[0];
	const [withoutTag] = normalized.split(":", 1);
	const segments = withoutTag.split("/");

	if (segments.length < 3) {
		throw new Error(
			`RENOVATE_IMAGE_REPOSITORY must look like ghcr.io/<owner>/<package>, received: ${imageRepository}`,
		);
	}

	return {
		owner: segments[1],
		packageName: segments.slice(2).join("/"),
		registry: segments[0].toLowerCase(),
	};
}

async function collectKeepTags({ fetchImpl, repo, repoOwner, token }) {
	const keepTags = new Set();
	const branches = await listPaginated(
		fetchImpl,
		token,
		`/repos/${repoOwner}/${repo}/branches`,
	);
	const pullRequests = await listPaginated(
		fetchImpl,
		token,
		`/repos/${repoOwner}/${repo}/pulls?state=open`,
	);

	for (const branch of branches) {
		const branchName =
			typeof branch?.name === "string" && branch.name.length > 0
				? branch.name
				: "";
		const branchSha =
			typeof branch?.commit?.sha === "string" && branch.commit.sha.length > 0
				? branch.commit.sha
				: "";

		if (branchName.length === 0 || branchSha.length === 0) {
			continue;
		}

		const runtimeConfig = await readRuntimeConfigForRef({
			fetchImpl,
			ref: branchSha,
			repo,
			repoOwner,
			token,
		});

		if (!runtimeConfig) {
			continue;
		}

		keepTags.add(
			buildBranchCacheTag({
				baseImage: runtimeConfig.baseImage,
				branchName,
				renovateVersion: runtimeConfig.renovateVersion,
			}),
		);
	}

	for (const pullRequest of pullRequests) {
		const prNumber = normalizePullRequestNumber(pullRequest?.number);

		if (prNumber === null) {
			continue;
		}

		const runtimeConfig = await readRuntimeConfigForRef({
			fetchImpl,
			ref: `refs/pull/${prNumber}/head`,
			repo,
			repoOwner,
			token,
		});

		if (!runtimeConfig) {
			continue;
		}

		keepTags.add(
			buildPrCacheTag({
				baseImage: runtimeConfig.baseImage,
				prNumber,
				renovateVersion: runtimeConfig.renovateVersion,
			}),
		);
	}

	return keepTags;
}

async function readRuntimeConfigForRef({
	fetchImpl,
	ref,
	repo,
	repoOwner,
	token,
}) {
	const [dockerfileText, installScriptText] = await Promise.all([
		readContentsFile({
			fetchImpl,
			path: "renovate/Dockerfile",
			ref,
			repo,
			repoOwner,
			token,
		}),
		readContentsFile({
			fetchImpl,
			path: "renovate/install.sh",
			ref,
			repo,
			repoOwner,
			token,
		}),
	]);

	if (!dockerfileText || !installScriptText) {
		return null;
	}

	return {
		baseImage: parseDockerfileBaseImage(dockerfileText),
		renovateVersion: parseRenovateVersion(installScriptText),
	};
}

async function readContentsFile({
	fetchImpl,
	path,
	ref,
	repo,
	repoOwner,
	token,
}) {
	try {
		const payload = await requestJson(
			fetchImpl,
			token,
			`/repos/${repoOwner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
		);
		return decodeContentsPayload(payload, path);
	} catch (error) {
		if (error?.status === 404) {
			return null;
		}

		throw error;
	}
}

function decodeContentsPayload(payload, filePath) {
	const content =
		typeof payload?.content === "string" && payload.content.length > 0
			? payload.content
			: "";
	const encoding =
		typeof payload?.encoding === "string" && payload.encoding.length > 0
			? payload.encoding
			: "";

	if (encoding !== "base64") {
		throw new Error(
			`GitHub returned unsupported encoding ${encoding || "<empty>"} for ${filePath}`,
		);
	}

	return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

function parseDockerfileBaseImage(source) {
	const match = source.match(/^ARG RENOVATE_BASE_IMAGE=(.+)$/mu);

	if (!match) {
		throw new Error(
			"Failed to read RENOVATE_BASE_IMAGE from renovate/Dockerfile",
		);
	}

	return match[1].trim();
}

function parseRenovateVersion(source) {
	const match = source.match(/^renovate_version="([^"\n]+)"$/mu);

	if (!match) {
		throw new Error("Failed to read renovate_version from renovate/install.sh");
	}

	return match[1];
}

function buildBranchCacheTag({ baseImage, branchName, renovateVersion }) {
	return buildCacheTag({
		baseImage,
		cacheKey: `branch-${sanitizeCacheKeyComponent(branchName)}`,
		renovateVersion,
	});
}

function buildPrCacheTag({ baseImage, prNumber, renovateVersion }) {
	return buildCacheTag({
		baseImage,
		cacheKey: `pr-${normalizePullRequestNumber(prNumber)}`,
		renovateVersion,
	});
}

function buildCacheTag({ baseImage, cacheKey, renovateVersion }) {
	return `cache-${cacheKey}-renovate-${renovateVersion}-base-${sha256Prefix(baseImage, 12)}`;
}

function sanitizeCacheKeyComponent(value) {
	const normalized = String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^[.-]+/u, "")
		.replace(/[.-]+$/u, "");
	const fallback = normalized.length > 0 ? normalized : "ref";

	if (fallback.length <= 48) {
		return fallback;
	}

	return `${fallback.slice(0, 39)}-${sha256Prefix(value, 8)}`;
}

function sha256Prefix(value, length) {
	return createHash("sha256")
		.update(String(value || ""), "utf8")
		.digest("hex")
		.slice(0, length);
}

function normalizePullRequestNumber(value) {
	const text = String(value ?? "");

	if (!/^[1-9]\d*$/u.test(text)) {
		return null;
	}

	return text;
}

function readPackageVersionTags(version) {
	const tags = Array.isArray(version?.metadata?.container?.tags)
		? version.metadata.container.tags
		: [];

	return [
		...new Set(tags.filter((tag) => typeof tag === "string" && tag.length > 0)),
	].sort();
}

function normalizePackageVersionId(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}

	return typeof value === "string" && value.length > 0 ? value : null;
}

async function resolvePackageOwnerType({
	fetchImpl,
	packageOwner,
	repoInfo,
	token,
}) {
	if (
		typeof repoInfo?.owner?.login === "string" &&
		repoInfo.owner.login.toLowerCase() === packageOwner.toLowerCase() &&
		typeof repoInfo?.owner?.type === "string"
	) {
		return repoInfo.owner.type;
	}

	const owner = await requestJson(fetchImpl, token, `/users/${packageOwner}`);
	return typeof owner?.type === "string" ? owner.type : "User";
}

function buildPackageVersionsPath({ owner, ownerType, packageName }) {
	const ownerPath = ownerType === "Organization" ? "orgs" : "users";
	return `/${ownerPath}/${owner}/packages/container/${packageName}/versions`;
}

async function listPaginated(fetchImpl, token, path) {
	const items = [];

	for (let page = 1; ; page += 1) {
		const separator = path.includes("?") ? "&" : "?";
		const pageItems = await requestJson(
			fetchImpl,
			token,
			`${path}${separator}per_page=100&page=${page}`,
		);

		if (!Array.isArray(pageItems)) {
			throw new Error(`Expected an array response from ${path}`);
		}

		items.push(...pageItems);

		if (pageItems.length < 100) {
			return items;
		}
	}
}

function readGitHubToken(env) {
	for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
		if (typeof env[key] === "string" && env[key].length > 0) {
			return env[key];
		}
	}

	return "";
}

async function requestJson(fetchImpl, token, path) {
	const response = await request(fetchImpl, token, { method: "GET", path });
	return response.json();
}

async function request(fetchImpl, token, { method, path }) {
	if (typeof fetchImpl !== "function") {
		throw new Error("A fetch implementation is required");
	}

	const response = await fetchImpl(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "linter-service-renovate-cache-pruner",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		method,
	});

	if (response.ok) {
		return response;
	}

	let message = `GitHub API ${method} ${path} failed with status ${response.status}`;

	try {
		const payload = await response.json();
		if (typeof payload?.message === "string" && payload.message.length > 0) {
			message = payload.message;
		}
	} catch {
		// Ignore JSON parse failures and keep the default message.
	}

	const error = new Error(message);
	error.status = response.status;
	throw error;
}

if (require.main === module) {
	pruneRenovateCacheImages().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

module.exports = {
	buildBranchCacheTag,
	buildPrCacheTag,
	parseDockerfileBaseImage,
	parseImageRepository,
	parseRenovateVersion,
	pruneRenovateCacheImages,
	sanitizeCacheKeyComponent,
};
