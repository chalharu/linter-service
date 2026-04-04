import { createHmac } from "node:crypto";
import { SignJWT } from "jose";

export interface Env {
	GITHUB_CHECKER_APP_ID?: string;
	GITHUB_CHECKER_APP_PRIVATE_KEY?: string;
	GITHUB_DISPATCHER_APP_ID: string;
	GITHUB_DISPATCHER_APP_PRIVATE_KEY: string;
	GITHUB_CHECKER_WEBHOOK_SECRET: string;
	GITHUB_DISPATCH_OWNER: string;
	GITHUB_DISPATCH_REPO: string;
	GITHUB_API_BASE_URL?: string;
}

type JsonRecord = Record<string, unknown>;

interface GitHubInstallation {
	id?: number;
}

interface GitHubUser {
	id?: number;
	login?: string;
	type?: string;
	html_url?: string;
}

interface GitHubRepository {
	id?: number;
	name?: string;
	full_name?: string;
	private?: boolean;
	html_url?: string;
	clone_url?: string;
	default_branch?: string;
	owner?: GitHubUser;
}

interface GitHubPullRequestBranch {
	label?: string;
	ref?: string;
	sha?: string;
	repo?: GitHubRepository;
}

interface GitHubPullRequest {
	id?: number;
	number: number;
	title?: string;
	html_url?: string;
	state?: string;
	draft?: boolean;
	merged?: boolean;
	user?: GitHubUser;
	head: GitHubPullRequestBranch;
	base: GitHubPullRequestBranch;
}

interface GitHubCheckRunApp {
	id?: number;
	name?: string;
	slug?: string;
	owner?: GitHubUser;
}

interface AssociatedPullRequest {
	number?: number;
}

interface GitHubCheckRun {
	id?: number;
	name?: string;
	status?: string;
	conclusion?: string | null;
	external_id?: string;
	html_url?: string;
	details_url?: string;
	head_sha?: string;
	app?: GitHubCheckRunApp;
	pull_requests?: AssociatedPullRequest[];
	check_suite?: {
		pull_requests?: AssociatedPullRequest[];
	};
}

interface PullRequestEventPayload {
	action: string;
	changes?: JsonRecord;
	installation?: GitHubInstallation;
	repository: GitHubRepository;
	pull_request: GitHubPullRequest;
	sender?: GitHubUser;
}

interface CheckRunEventPayload {
	action: string;
	installation?: GitHubInstallation;
	repository: GitHubRepository;
	check_run: GitHubCheckRun;
	sender?: GitHubUser;
}

interface PushEventPayload {
	after: string;
	before?: string;
	created?: boolean;
	deleted?: boolean;
	forced?: boolean;
	installation?: GitHubInstallation;
	ref: string;
	repository: GitHubRepository;
	sender?: GitHubUser;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DISPATCH_EVENT_TYPE = "github_app_webhook";
const FORWARDED_PULL_REQUEST_ACTIONS = new Set([
	"opened",
	"ready_for_review",
	"reopened",
	"synchronize",
]);
const CHECK_RUN_SKIP_REASON =
	"check_run events are not forwarded because pull_request events are authoritative";
const CHECK_RUNS_PAGE_SIZE = 100;
const GITHUB_API_VERSION = "2022-11-28";
const MANAGED_CHECK_RUN_EXTERNAL_ID_PREFIX = "linter-service:";
const PROCESSING_CHECK_NAME = "linter-service";
const QUEUED_PROCESSING_CHECK_SUMMARY =
	"The linter-service workflow request is being queued and should start shortly.";
const QUEUED_PROCESSING_CHECK_TITLE = `${PROCESSING_CHECK_NAME} is queued`;
const SELF_WEBHOOK_SKIP_REASON =
	"webhook events from the dispatch target repository are handled directly";
const DISPATCH_SIGNATURE_PREFIX = "sha256=";
const USER_AGENT = "linter-service-webhook-proxy";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await routeRequest(request, env);
		} catch (error) {
			if (error instanceof HttpError) {
				return json({ error: error.message }, error.status);
			}

			console.error("Unexpected error in webhook handler", error);
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;

async function routeRequest(request: Request, env: Env): Promise<Response> {
	if (request.method === "GET") {
		return json({
			ok: true,
			service: "github-webhook-proxy",
		});
	}

	if (request.method !== "POST") {
		throw new HttpError(405, "method not allowed");
	}

	return handleWebhook(request, env);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const webhookSecret = requireEnv(
		env.GITHUB_CHECKER_WEBHOOK_SECRET,
		"GITHUB_CHECKER_WEBHOOK_SECRET",
	);
	const eventName = requireHeader(request.headers, "x-github-event");
	const deliveryId = requireHeader(request.headers, "x-github-delivery");
	const signature = requireHeader(request.headers, "x-hub-signature-256");
	const rawBody = await request.text();

	await verifySignature(rawBody, signature, webhookSecret);

	const payload = parseJson(rawBody);

	switch (eventName) {
		case "pull_request":
			assertPullRequestEventPayload(payload);
			return handlePullRequestEvent(payload, deliveryId, env);
		case "push":
			assertPushEventPayload(payload);
			return handlePushEvent(payload, deliveryId, env);
		case "check_run":
			assertCheckRunEventPayload(payload);
			return handleCheckRunEvent(payload, deliveryId, env);
		default:
			return json(
				{
					ok: true,
					dispatched: false,
					skipped: true,
					reason: `unsupported event: ${eventName}`,
				},
				202,
			);
	}
}

async function handlePullRequestEvent(
	payload: PullRequestEventPayload,
	deliveryId: string,
	env: Env,
): Promise<Response> {
	if (!isForwardedPullRequestEvent(payload)) {
		return skippedResponse(
			`pull_request action is not forwarded: ${payload.action}`,
		);
	}

	if (isDispatchTargetRepository(payload.repository, env)) {
		return skippedResponse(SELF_WEBHOOK_SKIP_REASON);
	}

	const sourceInstallationId = getSourceInstallationId(payload.installation);
	const dispatchToken = await createDispatchInstallationToken(env);

	await tryNotifyQueuedProcessingCheck(payload, env);

	await sendRepositoryDispatch(
		env,
		dispatchToken,
		buildPullRequestClientPayload({
			action: payload.action,
			deliveryId,
			pullRequest: normalizePullRequest(payload.pull_request),
			repository: payload.repository,
			sender: payload.sender,
			sourceInstallationId,
		}),
	);

	return dispatchedResponse({
		pull_request: {
			head_ref: payload.pull_request.head.ref ?? null,
			head_sha: payload.pull_request.head.sha ?? null,
			number: payload.pull_request.number,
		},
	});
}

async function handlePushEvent(
	payload: PushEventPayload,
	deliveryId: string,
	env: Env,
): Promise<Response> {
	if (isDispatchTargetRepository(payload.repository, env)) {
		return skippedResponse(SELF_WEBHOOK_SKIP_REASON);
	}

	if (!isForwardedPushEvent(payload)) {
		return skippedResponse(
			`push event is not forwarded: ref ${payload.ref} is not the default branch`,
		);
	}

	const sourceInstallationId = getSourceInstallationId(payload.installation);
	const dispatchToken = await createDispatchInstallationToken(env);

	await sendRepositoryDispatch(
		env,
		dispatchToken,
		buildPushClientPayload({
			deliveryId,
			push: payload,
			sender: payload.sender,
			sourceInstallationId,
		}),
	);

	return dispatchedResponse({
		push: {
			default_branch: payload.repository.default_branch ?? null,
			head_sha: payload.after,
			ref: payload.ref,
		},
	});
}

async function handleCheckRunEvent(
	payload: CheckRunEventPayload,
	_deliveryId: string,
	env: Env,
): Promise<Response> {
	if (isManagedLinterCheckRun(payload.check_run)) {
		return skippedResponse("check_run was generated by linter-service");
	}

	if (isDispatchTargetRepository(payload.repository, env)) {
		return skippedResponse(SELF_WEBHOOK_SKIP_REASON);
	}

	return skippedResponse(CHECK_RUN_SKIP_REASON);
}

function buildPullRequestClientPayload({
	action,
	deliveryId,
	pullRequest,
	repository,
	sender,
	sourceInstallationId,
}: {
	action: string;
	deliveryId: string;
	pullRequest: JsonRecord;
	repository: GitHubRepository;
	sender?: GitHubUser;
	sourceInstallationId: number;
}): JsonRecord {
	const payload: JsonRecord = {
		action,
		delivery_id: deliveryId,
		event_name: "pull_request",
		pull_request: pullRequest,
		received_at: new Date().toISOString(),
		repository: normalizeRepository(repository),
		sender: normalizeUser(sender),
		source_installation_id: sourceInstallationId,
	};

	return payload;
}

function buildPushClientPayload({
	deliveryId,
	push,
	sender,
	sourceInstallationId,
}: {
	deliveryId: string;
	push: PushEventPayload;
	sender?: GitHubUser;
	sourceInstallationId: number;
}): JsonRecord {
	const payload: JsonRecord = {
		delivery_id: deliveryId,
		event_name: "push",
		push: normalizePushEvent(push),
		received_at: new Date().toISOString(),
		repository: normalizeRepository(push.repository),
		sender: normalizeUser(sender),
		source_installation_id: sourceInstallationId,
	};

	return payload;
}

function isDispatchTargetRepository(
	repository: GitHubRepository,
	env: Env,
): boolean {
	const dispatchOwner = requireEnv(
		env.GITHUB_DISPATCH_OWNER,
		"GITHUB_DISPATCH_OWNER",
	).toLowerCase();
	const dispatchRepo = requireEnv(
		env.GITHUB_DISPATCH_REPO,
		"GITHUB_DISPATCH_REPO",
	).toLowerCase();

	if (typeof repository.full_name === "string") {
		return (
			repository.full_name.toLowerCase() === `${dispatchOwner}/${dispatchRepo}`
		);
	}

	return (
		repository.owner?.login?.toLowerCase() === dispatchOwner &&
		repository.name?.toLowerCase() === dispatchRepo
	);
}

async function createDispatchInstallationToken(env: Env): Promise<string> {
	const appId = requireEnv(
		env.GITHUB_DISPATCHER_APP_ID,
		"GITHUB_DISPATCHER_APP_ID",
	);
	const privateKey = requireEnv(
		env.GITHUB_DISPATCHER_APP_PRIVATE_KEY,
		"GITHUB_DISPATCHER_APP_PRIVATE_KEY",
	);
	const appJwt = await createAppJwt(appId, privateKey, "dispatcher");
	const installationId = await resolveDispatchInstallationId(env, appJwt);

	return createInstallationToken(
		env,
		appJwt,
		installationId,
		"failed to create dispatcher installation token",
	);
}

async function resolveDispatchInstallationId(
	env: Env,
	appJwt: string,
): Promise<number> {
	const owner = requireEnv(env.GITHUB_DISPATCH_OWNER, "GITHUB_DISPATCH_OWNER");
	const repo = requireEnv(env.GITHUB_DISPATCH_REPO, "GITHUB_DISPATCH_REPO");

	return resolveRepositoryInstallationId(
		env,
		appJwt,
		owner,
		repo,
		"failed to resolve dispatcher installation",
	);
}

async function resolveRepositoryInstallationId(
	env: Env,
	appJwt: string,
	owner: string,
	repo: string,
	errorMessage: string,
): Promise<number> {
	const responseText = await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
		{
			headers: {
				...buildGitHubHeaders(undefined),
				Authorization: `Bearer ${appJwt}`,
			},
			method: "GET",
		},
		errorMessage,
	);
	const payload = parseJson(responseText);
	const installationId = isRecord(payload) ? payload.id : undefined;

	assertPositiveInteger(
		installationId,
		"GitHub installation response was malformed",
		502,
	);

	return installationId;
}

async function createInstallationToken(
	env: Env,
	appJwt: string,
	installationId: number,
	errorMessage: string,
): Promise<string> {
	const responseText = await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/app/installations/${installationId}/access_tokens`,
		{
			body: JSON.stringify({}),
			headers: {
				...buildGitHubHeaders(undefined),
				Authorization: `Bearer ${appJwt}`,
				"Content-Type": "application/json",
			},
			method: "POST",
		},
		errorMessage,
	);
	const payload = parseJson(responseText);

	if (!isRecord(payload) || typeof payload.token !== "string") {
		throw new HttpError(
			502,
			"GitHub installation token response was malformed",
		);
	}

	return payload.token;
}

async function createCheckerInstallationTokenForRepository(
	env: Env,
	owner: string,
	repo: string,
): Promise<string> {
	const appId = requireEnv(env.GITHUB_CHECKER_APP_ID, "GITHUB_CHECKER_APP_ID");
	const privateKey = requireEnv(
		env.GITHUB_CHECKER_APP_PRIVATE_KEY,
		"GITHUB_CHECKER_APP_PRIVATE_KEY",
	);
	const appJwt = await createAppJwt(appId, privateKey, "checker");
	const installationId = await resolveRepositoryInstallationId(
		env,
		appJwt,
		owner,
		repo,
		"failed to resolve checker installation",
	);

	return createInstallationToken(
		env,
		appJwt,
		installationId,
		"failed to create checker installation token",
	);
}

async function createAppJwt(
	appId: string,
	privateKeyPem: string,
	appName: string,
): Promise<string> {
	try {
		const key = await importAppPrivateKey(privateKeyPem);
		const now = Math.floor(Date.now() / 1000);

		return new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			.setIssuedAt(now - 60)
			.setExpirationTime(now + 9 * 60)
			.setIssuer(appId)
			.sign(key);
	} catch (error) {
		console.error(`failed to create ${appName} app JWT`, error);
		throw new HttpError(500, `failed to create ${appName} app JWT`);
	}
}

async function sendRepositoryDispatch(
	env: Env,
	token: string,
	clientPayload: JsonRecord,
): Promise<void> {
	const signedPayload = signDispatchPayload(
		requireEnv(
			env.GITHUB_CHECKER_APP_PRIVATE_KEY,
			"GITHUB_CHECKER_APP_PRIVATE_KEY",
		),
		clientPayload,
	);
	const owner = requireEnv(env.GITHUB_DISPATCH_OWNER, "GITHUB_DISPATCH_OWNER");
	const repo = requireEnv(env.GITHUB_DISPATCH_REPO, "GITHUB_DISPATCH_REPO");

	await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
		{
			body: JSON.stringify({
				client_payload: signedPayload,
				event_type: DISPATCH_EVENT_TYPE,
			}),
			headers: {
				...buildGitHubHeaders(token),
				"Content-Type": "application/json",
			},
			method: "POST",
		},
		"failed to send repository_dispatch",
	);
}

function signDispatchPayload(secret: string, payload: JsonRecord): JsonRecord {
	return {
		...payload,
		signature: `${DISPATCH_SIGNATURE_PREFIX}${createHmac("sha256", secret)
			.update(stableStringify(payload))
			.digest("hex")}`,
	};
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}

	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify((value as JsonRecord)[key])}`,
			)
			.join(",")}}`;
	}

	return JSON.stringify(value);
}

async function tryNotifyQueuedProcessingCheck(
	payload: PullRequestEventPayload,
	env: Env,
): Promise<void> {
	if (
		typeof env.GITHUB_CHECKER_APP_ID !== "string" ||
		env.GITHUB_CHECKER_APP_ID.trim().length === 0 ||
		typeof env.GITHUB_CHECKER_APP_PRIVATE_KEY !== "string" ||
		env.GITHUB_CHECKER_APP_PRIVATE_KEY.trim().length === 0
	) {
		console.error(
			"skipping queued processing check because checker app credentials are not configured",
		);
		return;
	}

	const context = resolvePullRequestProcessingCheckContext(payload);

	if (!context) {
		console.error(
			"skipping queued processing check because the pull_request payload is missing source repository metadata or head SHA",
		);
		return;
	}

	try {
		const checkerToken = await createCheckerInstallationTokenForRepository(
			env,
			context.owner,
			context.repo,
		);

		await upsertQueuedProcessingCheck(env, checkerToken, context);
	} catch (error) {
		console.error("failed to notify queued processing check", {
			error,
			externalId: context.externalId,
			headSha: context.headSha,
			owner: context.owner,
			repo: context.repo,
		});
	}
}

function resolvePullRequestProcessingCheckContext(
	payload: PullRequestEventPayload,
): {
	detailsUrl?: string;
	externalId: string;
	headSha: string;
	owner: string;
	repo: string;
} | null {
	const owner =
		normalizeOptionalString(payload.pull_request.head.repo?.owner?.login) ??
		normalizeOptionalString(payload.repository.owner?.login);
	const repo =
		normalizeOptionalString(payload.pull_request.head.repo?.name) ??
		normalizeOptionalString(payload.repository.name);
	const headSha = normalizeOptionalString(payload.pull_request.head.sha);

	if (!owner || !repo || !headSha) {
		return null;
	}

	return {
		detailsUrl:
			normalizeOptionalString(payload.pull_request.html_url) ??
			normalizeOptionalString(payload.repository.html_url) ??
			undefined,
		externalId: buildProcessingCheckExternalId(
			payload.pull_request.number,
			headSha,
		),
		headSha,
		owner,
		repo,
	};
}

function buildProcessingCheckExternalId(
	pullRequestNumber: number,
	headSha: string,
): string {
	return `${PROCESSING_CHECK_NAME}:${pullRequestNumber}:${headSha}`;
}

async function upsertQueuedProcessingCheck(
	env: Env,
	token: string,
	context: {
		detailsUrl?: string;
		externalId: string;
		headSha: string;
		owner: string;
		repo: string;
	},
): Promise<void> {
	const existingCheckRunId = await findCheckRunIdByExternalId(
		env,
		token,
		context.owner,
		context.repo,
		context.headSha,
		context.externalId,
	);
	const output = {
		summary: QUEUED_PROCESSING_CHECK_SUMMARY,
		title: QUEUED_PROCESSING_CHECK_TITLE,
	};

	if (existingCheckRunId !== null) {
		await fetchGitHubText(
			`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/check-runs/${existingCheckRunId}`,
			{
				body: JSON.stringify({
					details_url: context.detailsUrl,
					external_id: context.externalId,
					output,
					status: "queued",
				}),
				headers: {
					...buildGitHubHeaders(token),
					"Content-Type": "application/json",
				},
				method: "PATCH",
			},
			"failed to update queued processing check",
		);
		return;
	}

	await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/check-runs`,
		{
			body: JSON.stringify({
				details_url: context.detailsUrl,
				external_id: context.externalId,
				head_sha: context.headSha,
				name: PROCESSING_CHECK_NAME,
				output,
				status: "queued",
			}),
			headers: {
				...buildGitHubHeaders(token),
				"Content-Type": "application/json",
			},
			method: "POST",
		},
		"failed to create queued processing check",
	);
}

async function findCheckRunIdByExternalId(
	env: Env,
	token: string,
	owner: string,
	repo: string,
	headSha: string,
	externalId: string,
): Promise<number | null> {
	for (let page = 1; ; page += 1) {
		const query = new URLSearchParams({
			check_name: PROCESSING_CHECK_NAME,
			page: String(page),
			per_page: String(CHECK_RUNS_PAGE_SIZE),
		});
		const responseText = await fetchGitHubText(
			`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?${query.toString()}`,
			{
				headers: buildGitHubHeaders(token),
				method: "GET",
			},
			"failed to list queued processing check runs",
		);
		const payload = parseJson(responseText);
		const checkRuns = isRecord(payload) ? payload.check_runs : undefined;

		if (!Array.isArray(checkRuns)) {
			throw new HttpError(502, "GitHub check runs response was malformed");
		}

		for (const checkRun of checkRuns) {
			if (
				isRecord(checkRun) &&
				checkRun.external_id === externalId &&
				typeof checkRun.id === "number" &&
				Number.isInteger(checkRun.id) &&
				checkRun.id > 0
			) {
				return checkRun.id;
			}
		}

		if (checkRuns.length < CHECK_RUNS_PAGE_SIZE) {
			return null;
		}
	}
}

async function fetchGitHubText(
	url: string,
	init: RequestInit,
	errorMessage: string,
): Promise<string> {
	let response: Response;

	try {
		response = await fetch(url, init);
	} catch (error) {
		console.error(errorMessage, {
			error,
			url,
		});
		throw new HttpError(502, errorMessage);
	}

	let responseText: string;

	try {
		responseText = await response.text();
	} catch (error) {
		console.error(errorMessage, {
			error,
			url,
		});
		throw new HttpError(502, errorMessage);
	}

	if (!response.ok) {
		console.error(errorMessage, {
			responseText,
			status: response.status,
			url,
		});
		throw new HttpError(502, errorMessage);
	}

	return responseText;
}

function buildGitHubHeaders(token: string | undefined): HeadersInit {
	return {
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		Accept: "application/vnd.github+json",
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
}

async function verifySignature(
	rawBody: string,
	receivedSignature: string,
	webhookSecret: string,
): Promise<void> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(webhookSecret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(rawBody),
	);
	const expectedSignature = `sha256=${toHex(new Uint8Array(signature))}`;

	if (!timingSafeEqual(expectedSignature, receivedSignature)) {
		throw new HttpError(401, "invalid webhook signature");
	}
}

function getSourceInstallationId(
	installation: GitHubInstallation | undefined,
): number {
	const installationId = installation?.id;
	assertPositiveInteger(installationId, "payload installation.id is required");

	return installationId;
}

function normalizePullRequest(pullRequest: GitHubPullRequest): JsonRecord {
	return {
		author: normalizeUser(pullRequest.user),
		base: normalizePullRequestBranch(pullRequest.base),
		draft: pullRequest.draft ?? null,
		html_url: pullRequest.html_url ?? null,
		id: pullRequest.id ?? null,
		merged: pullRequest.merged ?? null,
		number: pullRequest.number,
		head: normalizePullRequestBranch(pullRequest.head),
		state: pullRequest.state ?? null,
		title: pullRequest.title ?? null,
	};
}

function normalizePullRequestBranch(
	branch: GitHubPullRequestBranch,
): JsonRecord {
	return {
		label: branch.label ?? null,
		ref: branch.ref ?? null,
		repo: normalizeRepository(branch.repo),
		sha: branch.sha ?? null,
	};
}

function normalizePushEvent(payload: PushEventPayload): JsonRecord {
	return {
		after: payload.after,
		before: payload.before ?? null,
		created: typeof payload.created === "boolean" ? payload.created : null,
		deleted: typeof payload.deleted === "boolean" ? payload.deleted : null,
		forced: typeof payload.forced === "boolean" ? payload.forced : null,
		ref: payload.ref,
		ref_name: normalizeRefName(payload.ref),
	};
}

function normalizeRepository(
	repository: GitHubRepository | undefined,
): JsonRecord | null {
	if (!repository) {
		return null;
	}

	return {
		clone_url: repository.clone_url ?? null,
		default_branch: repository.default_branch ?? null,
		full_name: repository.full_name ?? null,
		html_url: repository.html_url ?? null,
		id: repository.id ?? null,
		name: repository.name ?? null,
		owner: normalizeUser(repository.owner),
		private:
			typeof repository.private === "boolean" ? repository.private : null,
	};
}

function normalizeUser(user: GitHubUser | undefined): JsonRecord | null {
	if (!user) {
		return null;
	}

	return {
		html_url: user.html_url ?? null,
		id: user.id ?? null,
		login: user.login ?? null,
		type: user.type ?? null,
	};
}

function normalizeOptionalString(value: string | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalizedValue = value.trim();
	return normalizedValue.length > 0 ? normalizedValue : null;
}

function requireEnv(value: string | undefined, name: string): string {
	const normalizedValue = value?.trim();

	if (!normalizedValue) {
		throw new HttpError(500, `${name} is required`);
	}

	return normalizedValue;
}

function requireHeader(headers: Headers, name: string): string {
	const value = headers.get(name)?.trim();

	if (!value) {
		throw new HttpError(400, `${name} header is required`);
	}

	return value;
}

function parseJson(input: string): unknown {
	try {
		return JSON.parse(input) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new HttpError(400, "request body must be valid JSON");
		}

		throw error;
	}
}

function skippedResponse(reason: string): Response {
	return json(
		{
			ok: true,
			dispatched: false,
			skipped: true,
			reason,
		},
		202,
	);
}

function dispatchedResponse(details: JsonRecord): Response {
	return json(
		{
			ok: true,
			dispatched: true,
			skipped: false,
			...details,
		},
		200,
	);
}

function getGitHubApiBaseUrl(env: Env): string {
	const baseUrl = env.GITHUB_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
	let parsedUrl: URL;

	try {
		parsedUrl = new URL(baseUrl);
	} catch {
		throw new HttpError(500, "GITHUB_API_BASE_URL must be a valid HTTPS URL");
	}

	if (
		parsedUrl.protocol !== "https:" ||
		parsedUrl.username ||
		parsedUrl.password ||
		parsedUrl.search ||
		parsedUrl.hash
	) {
		throw new HttpError(500, "GITHUB_API_BASE_URL must be a valid HTTPS URL");
	}

	parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

	return parsedUrl.toString().replace(/\/$/, "");
}

function normalizeMultilineSecret(secret: string): string {
	const trimmedSecret = secret.trim();
	const unwrappedSecret =
		trimmedSecret.startsWith('"') && trimmedSecret.endsWith('"')
			? trimmedSecret.slice(1, -1)
			: trimmedSecret;

	return unwrappedSecret.replace(/\\n/g, "\n");
}

async function importAppPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
	const normalizedPrivateKeyPem = normalizeMultilineSecret(privateKeyPem);
	const keyData = normalizedPrivateKeyPem.includes("BEGIN RSA PRIVATE KEY")
		? wrapPkcs1RsaPrivateKey(
				pemBlockToDer(normalizedPrivateKeyPem, "RSA PRIVATE KEY"),
			)
		: pemBlockToDer(normalizedPrivateKeyPem, "PRIVATE KEY");

	return crypto.subtle.importKey(
		"pkcs8",
		toArrayBuffer(keyData),
		{ hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
		false,
		["sign"],
	);
}

function pemBlockToDer(pem: string, label: string): Uint8Array {
	const normalizedPem = pem.replace(/\r/g, "");
	const pemMatcher = new RegExp(
		`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`,
	);
	const match = normalizedPem.match(pemMatcher);

	if (!match) {
		throw new Error(`missing PEM block: ${label}`);
	}

	const base64Payload = match[1].replace(/\s+/g, "");
	const binary = atob(base64Payload);
	const bytes = new Uint8Array(binary.length);

	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

function wrapPkcs1RsaPrivateKey(pkcs1KeyBytes: Uint8Array): Uint8Array {
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const algorithmIdentifier = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	]);
	const privateKeyOctetString = encodeDerElement(0x04, pkcs1KeyBytes);

	return encodeDerElement(
		0x30,
		concatUint8Arrays(version, algorithmIdentifier, privateKeyOctetString),
	);
}

function encodeDerElement(tag: number, body: Uint8Array): Uint8Array {
	return concatUint8Arrays(
		new Uint8Array([tag]),
		encodeDerLength(body.length),
		body,
	);
}

function encodeDerLength(length: number): Uint8Array {
	if (length < 0x80) {
		return new Uint8Array([length]);
	}

	const bytes: number[] = [];
	let remainingLength = length;

	while (remainingLength > 0) {
		bytes.unshift(remainingLength & 0xff);
		remainingLength >>= 8;
	}

	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
	const totalLength = arrays.reduce(
		(currentLength, array) => currentLength + array.length,
		0,
	);
	const combined = new Uint8Array(totalLength);
	let offset = 0;

	for (const array of arrays) {
		combined.set(array, offset);
		offset += array.length;
	}

	return combined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function isManagedLinterCheckRun(checkRun: GitHubCheckRun): boolean {
	return (
		typeof checkRun.external_id === "string" &&
		checkRun.external_id.startsWith(MANAGED_CHECK_RUN_EXTERNAL_ID_PREFIX)
	);
}

function isForwardedPullRequestEvent(
	payload: PullRequestEventPayload,
): boolean {
	return (
		FORWARDED_PULL_REQUEST_ACTIONS.has(payload.action) ||
		hasPullRequestBaseChange(payload)
	);
}

function isForwardedPushEvent(payload: PushEventPayload): boolean {
	if (payload.deleted) {
		return false;
	}

	const defaultBranch = payload.repository.default_branch;

	return (
		typeof defaultBranch === "string" &&
		defaultBranch.length > 0 &&
		payload.ref === `refs/heads/${defaultBranch}`
	);
}

function hasPullRequestBaseChange(payload: PullRequestEventPayload): boolean {
	if (payload.action !== "edited") {
		return false;
	}

	const changes = payload.changes;

	return (
		isRecord(changes) &&
		isRecord(changes.base) &&
		isRecord(changes.base.ref) &&
		typeof changes.base.ref.from === "string"
	);
}

function normalizeRefName(ref: string): string {
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function timingSafeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	const maxLength = Math.max(leftBytes.length, rightBytes.length);
	let mismatch = leftBytes.length ^ rightBytes.length;

	for (let index = 0; index < maxLength; index += 1) {
		const leftByte = index < leftBytes.length ? leftBytes[index] : 0;
		const rightByte = index < rightBytes.length ? rightBytes[index] : 0;
		mismatch |= leftByte ^ rightByte;
	}

	return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
}

function assertPositiveInteger(
	value: unknown,
	message: string,
	status = 400,
): asserts value is number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new HttpError(status, message);
	}
}

function assertPullRequestEventPayload(
	payload: unknown,
): asserts payload is PullRequestEventPayload {
	if (
		!isRecord(payload) ||
		typeof payload.action !== "string" ||
		!isRepository(payload.repository) ||
		!isPullRequest(payload.pull_request)
	) {
		throw new HttpError(400, "invalid pull_request payload");
	}
}

function assertCheckRunEventPayload(
	payload: unknown,
): asserts payload is CheckRunEventPayload {
	if (
		!isRecord(payload) ||
		typeof payload.action !== "string" ||
		!isRepository(payload.repository) ||
		!isCheckRun(payload.check_run)
	) {
		throw new HttpError(400, "invalid check_run payload");
	}
}

function assertPushEventPayload(
	payload: unknown,
): asserts payload is PushEventPayload {
	if (
		!isRecord(payload) ||
		typeof payload.after !== "string" ||
		typeof payload.ref !== "string" ||
		!isRepository(payload.repository) ||
		typeof payload.repository.default_branch !== "string" ||
		payload.repository.default_branch.length === 0
	) {
		throw new HttpError(400, "invalid push payload");
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function isRepository(value: unknown): value is GitHubRepository {
	return isRecord(value) && typeof value.full_name === "string";
}

function isPullRequest(value: unknown): value is GitHubPullRequest {
	const pullRequestNumber = isRecord(value) ? value.number : undefined;

	return (
		isRecord(value) &&
		typeof pullRequestNumber === "number" &&
		Number.isInteger(pullRequestNumber) &&
		pullRequestNumber > 0 &&
		isRecord(value.head) &&
		isRecord(value.base)
	);
}

function isCheckRun(value: unknown): value is GitHubCheckRun {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		typeof value.name === "string" &&
		typeof value.status === "string" &&
		typeof value.head_sha === "string"
	);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
		status,
	});
}
