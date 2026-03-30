import { importPKCS8, SignJWT } from "jose";

export interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_DISPATCH_OWNER: string;
	GITHUB_DISPATCH_REPO: string;
	GITHUB_DISPATCH_EVENT_TYPE?: string;
	GITHUB_DISPATCH_INSTALLATION_ID?: string;
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

interface InstallationContext {
	sourceInstallationId: number;
	dispatchInstallationId: number;
	getSourceToken: () => Promise<string>;
	getDispatchToken: () => Promise<string>;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_DISPATCH_EVENT_TYPE = "github_app_webhook";
const GITHUB_API_VERSION = "2022-11-28";
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
		env.GITHUB_WEBHOOK_SECRET,
		"GITHUB_WEBHOOK_SECRET",
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
	const sourceInstallationId = getSourceInstallationId(payload.installation);
	const installationContext = createInstallationContext(
		env,
		sourceInstallationId,
	);
	const dispatchToken = await installationContext.getDispatchToken();

	await sendRepositoryDispatch(
		env,
		dispatchToken,
		buildClientPayload({
			action: payload.action,
			deliveryId,
			dispatchInstallationId: installationContext.dispatchInstallationId,
			eventName: "pull_request",
			pullRequest: payload.pull_request,
			repository: payload.repository,
			sender: payload.sender,
			sourceInstallationId: installationContext.sourceInstallationId,
		}),
	);

	return json(
		{
			ok: true,
			dispatched: true,
			skipped: false,
			pull_request: {
				head_ref: payload.pull_request.head.ref ?? null,
				head_sha: payload.pull_request.head.sha ?? null,
				number: payload.pull_request.number,
			},
		},
		200,
	);
}

async function handleCheckRunEvent(
	payload: CheckRunEventPayload,
	deliveryId: string,
	env: Env,
): Promise<Response> {
	const sourceInstallationId = getSourceInstallationId(payload.installation);
	const installationContext = createInstallationContext(
		env,
		sourceInstallationId,
	);
	const pullRequest = await resolveCheckRunPullRequest(
		payload,
		env,
		installationContext.getSourceToken,
	);

	if (!pullRequest) {
		return json(
			{
				ok: true,
				dispatched: false,
				skipped: true,
				reason: "check_run is not associated with a pull request",
			},
			202,
		);
	}

	const dispatchToken = await installationContext.getDispatchToken();

	await sendRepositoryDispatch(
		env,
		dispatchToken,
		buildClientPayload({
			action: payload.action,
			checkRun: payload.check_run,
			deliveryId,
			dispatchInstallationId: installationContext.dispatchInstallationId,
			eventName: "check_run",
			pullRequest,
			repository: payload.repository,
			sender: payload.sender,
			sourceInstallationId: installationContext.sourceInstallationId,
		}),
	);

	return json(
		{
			ok: true,
			dispatched: true,
			skipped: false,
			pull_request: {
				head_ref: pullRequest.head.ref ?? null,
				head_sha: pullRequest.head.sha ?? null,
				number: pullRequest.number,
			},
		},
		200,
	);
}

function createInstallationContext(
	env: Env,
	sourceInstallationId: number,
): InstallationContext {
	const dispatchInstallationId = resolveDispatchInstallationId(
		env,
		sourceInstallationId,
	);
	let sourceTokenPromise: Promise<string> | undefined;
	let dispatchTokenPromise: Promise<string> | undefined;

	const getSourceToken = (): Promise<string> => {
		sourceTokenPromise ??= createInstallationToken(env, sourceInstallationId);
		return sourceTokenPromise;
	};

	const getDispatchToken = (): Promise<string> => {
		if (dispatchInstallationId === sourceInstallationId) {
			return getSourceToken();
		}

		dispatchTokenPromise ??= createInstallationToken(
			env,
			dispatchInstallationId,
		);
		return dispatchTokenPromise;
	};

	return {
		dispatchInstallationId,
		getDispatchToken,
		getSourceToken,
		sourceInstallationId,
	};
}

function buildClientPayload({
	action,
	checkRun,
	deliveryId,
	dispatchInstallationId,
	eventName,
	pullRequest,
	repository,
	sender,
	sourceInstallationId,
}: {
	action: string;
	checkRun?: GitHubCheckRun;
	deliveryId: string;
	dispatchInstallationId: number;
	eventName: "pull_request" | "check_run";
	pullRequest: GitHubPullRequest;
	repository: GitHubRepository;
	sender?: GitHubUser;
	sourceInstallationId: number;
}): JsonRecord {
	const payload: JsonRecord = {
		action,
		delivery_id: deliveryId,
		dispatch_installation_id: dispatchInstallationId,
		event_name: eventName,
		pull_request: normalizePullRequest(pullRequest),
		received_at: new Date().toISOString(),
		repository: normalizeRepository(repository),
		sender: normalizeUser(sender),
		source_installation_id: sourceInstallationId,
	};

	if (checkRun) {
		payload.check_run = normalizeCheckRun(checkRun);
	}

	return payload;
}

async function resolveCheckRunPullRequest(
	payload: CheckRunEventPayload,
	env: Env,
	getSourceToken: () => Promise<string>,
): Promise<GitHubPullRequest | null> {
	const associatedPullRequests =
		payload.check_run.pull_requests &&
		payload.check_run.pull_requests.length > 0
			? payload.check_run.pull_requests
			: (payload.check_run.check_suite?.pull_requests ?? []);

	if (associatedPullRequests.length === 0) {
		return null;
	}

	const pullRequestNumber = associatedPullRequests[0]?.number;

	assertPositiveInteger(
		pullRequestNumber,
		"check_run payload must include a positive pull request number",
	);

	const repositoryFullName = payload.repository.full_name;

	if (!repositoryFullName) {
		throw new HttpError(
			400,
			"check_run payload is missing repository.full_name",
		);
	}

	const { owner, repo } = splitRepositoryFullName(repositoryFullName);
	const sourceToken = await getSourceToken();

	return fetchPullRequest(env, sourceToken, owner, repo, pullRequestNumber);
}

async function fetchPullRequest(
	env: Env,
	token: string,
	owner: string,
	repo: string,
	pullRequestNumber: number,
): Promise<GitHubPullRequest> {
	const responseText = await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}`,
		{
			headers: buildGitHubHeaders(token),
			method: "GET",
		},
		"failed to fetch pull request details",
	);
	const payload = parseJson(responseText);

	if (!isPullRequest(payload)) {
		throw new HttpError(502, "GitHub pull request response was malformed");
	}

	return payload;
}

async function createInstallationToken(
	env: Env,
	installationId: number,
): Promise<string> {
	const appId = requireEnv(env.GITHUB_APP_ID, "GITHUB_APP_ID");
	const privateKey = normalizeMultilineSecret(
		requireEnv(env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY"),
	);
	const appJwt = await createAppJwt(appId, privateKey);
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
		"failed to create installation token",
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

async function createAppJwt(
	appId: string,
	privateKeyPem: string,
): Promise<string> {
	const key = await importPKCS8(privateKeyPem, "RS256");
	const now = Math.floor(Date.now() / 1000);

	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt(now - 60)
		.setExpirationTime(now + 9 * 60)
		.setIssuer(appId)
		.sign(key);
}

async function sendRepositoryDispatch(
	env: Env,
	token: string,
	clientPayload: JsonRecord,
): Promise<void> {
	const owner = requireEnv(env.GITHUB_DISPATCH_OWNER, "GITHUB_DISPATCH_OWNER");
	const repo = requireEnv(env.GITHUB_DISPATCH_REPO, "GITHUB_DISPATCH_REPO");
	const eventType =
		env.GITHUB_DISPATCH_EVENT_TYPE?.trim() || DEFAULT_DISPATCH_EVENT_TYPE;

	await fetchGitHubText(
		`${getGitHubApiBaseUrl(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`,
		{
			body: JSON.stringify({
				client_payload: clientPayload,
				event_type: eventType,
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

async function fetchGitHubText(
	url: string,
	init: RequestInit,
	errorMessage: string,
): Promise<string> {
	const response = await fetch(url, init);
	const responseText = await response.text();

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

function resolveDispatchInstallationId(
	env: Env,
	sourceInstallationId: number,
): number {
	const rawDispatchInstallationId = env.GITHUB_DISPATCH_INSTALLATION_ID?.trim();

	if (!rawDispatchInstallationId) {
		return sourceInstallationId;
	}

	const parsedDispatchInstallationId = Number(rawDispatchInstallationId);
	assertPositiveInteger(
		parsedDispatchInstallationId,
		"GITHUB_DISPATCH_INSTALLATION_ID must be a positive integer",
		500,
	);

	return parsedDispatchInstallationId;
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

function normalizeCheckRun(checkRun: GitHubCheckRun): JsonRecord {
	return {
		app: checkRun.app
			? {
					id: checkRun.app.id ?? null,
					name: checkRun.app.name ?? null,
					owner: normalizeUser(checkRun.app.owner),
					slug: checkRun.app.slug ?? null,
				}
			: null,
		conclusion: checkRun.conclusion ?? null,
		details_url: checkRun.details_url ?? null,
		head_sha: checkRun.head_sha ?? null,
		html_url: checkRun.html_url ?? null,
		id: checkRun.id ?? null,
		name: checkRun.name ?? null,
		status: checkRun.status ?? null,
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

function splitRepositoryFullName(fullName: string): {
	owner: string;
	repo: string;
} {
	const [rawOwner, rawRepo, ...rest] = fullName.split("/");
	const owner = rawOwner?.trim();
	const repo = rawRepo?.trim();

	if (!owner || !repo || rest.length > 0) {
		throw new HttpError(400, `repository.full_name is invalid: ${fullName}`);
	}

	return { owner, repo };
}

function getGitHubApiBaseUrl(env: Env): string {
	return (env.GITHUB_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(
		/\/+$/,
		"",
	);
}

function normalizeMultilineSecret(secret: string): string {
	return secret.replace(/\\n/g, "\n");
}

function timingSafeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);

	if (leftBytes.length !== rightBytes.length) {
		return false;
	}

	let mismatch = 0;

	for (let index = 0; index < leftBytes.length; index += 1) {
		mismatch |= leftBytes[index] ^ rightBytes[index];
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
