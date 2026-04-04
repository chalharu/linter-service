import { createHmac, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/index";

const require = createRequire(import.meta.url);
const { verifyDispatchSignature } =
	require("../../.github/scripts/verify-dispatch-signature.js") as {
		verifyDispatchSignature: ({
			payloadJson,
			secret,
		}: {
			payloadJson: string;
			secret: string;
		}) => void;
	};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY = privateKey
	.export({ format: "pem", type: "pkcs1" })
	.toString();

const baseEnv: Env = {
	GITHUB_CHECKER_APP_ID: "987654",
	GITHUB_CHECKER_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
	GITHUB_CHECKER_WEBHOOK_SECRET: "super-secret",
	GITHUB_DISPATCHER_APP_ID: "123456",
	GITHUB_DISPATCHER_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
	GITHUB_DISPATCH_OWNER: "chalharu",
	GITHUB_DISPATCH_REPO: "linter-service",
};

describe("github webhook proxy worker", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("dispatches normalized pull_request payloads with the dispatcher app", async () => {
		const fetchMock = vi.mocked(fetch);

		mockPullRequestDispatchAndQueuedCheck(fetchMock);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: {
						label: "acme:main",
						ref: "main",
						repo: {
							full_name: "acme/source-repo",
							html_url: "https://github.com/acme/source-repo",
							id: 10,
							name: "source-repo",
							owner: { id: 1, login: "acme", type: "Organization" },
							private: false,
						},
						sha: "def456",
					},
					draft: false,
					head: {
						label: "octocat:feature/example",
						ref: "feature/example",
						repo: {
							clone_url: "https://github.com/octocat/forked-repo.git",
							full_name: "octocat/forked-repo",
							html_url: "https://github.com/octocat/forked-repo",
							id: 11,
							name: "forked-repo",
							owner: { id: 2, login: "octocat", type: "User" },
							private: false,
						},
						sha: "abc123",
					},
					html_url: "https://github.com/acme/source-repo/pull/42",
					id: 42,
					merged: false,
					number: 42,
					state: "open",
					title: "Add feature",
					user: { id: 2, login: "octocat", type: "User" },
				},
				repository: {
					full_name: "acme/source-repo",
					html_url: "https://github.com/acme/source-repo",
					id: 10,
					name: "source-repo",
					owner: { id: 1, login: "acme", type: "Organization" },
					private: false,
				},
				sender: { id: 2, login: "octocat", type: "User" },
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			pull_request: { head_ref: string; number: number };
		}>();

		expect(response.status).toBe(200);
		expect(responseJson.dispatched).toBe(true);
		expect(responseJson.pull_request).toEqual({
			head_ref: "feature/example",
			head_sha: "abc123",
			number: 42,
		});
		expect(fetchMock).toHaveBeenCalledTimes(7);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/repos/chalharu/linter-service/installation",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/app/installations/456/access_tokens",
		);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://api.github.com/repos/octocat/forked-repo/installation",
		);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(
			"https://api.github.com/app/installations/654/access_tokens",
		);
		expect(fetchMock.mock.calls[4]?.[0]).toBe(
			"https://api.github.com/repos/octocat/forked-repo/commits/abc123/check-runs?check_name=linter-service&page=1&per_page=100",
		);
		expect(fetchMock.mock.calls[5]?.[0]).toBe(
			"https://api.github.com/repos/octocat/forked-repo/check-runs",
		);
		expect(fetchMock.mock.calls[6]?.[0]).toBe(
			"https://api.github.com/repos/chalharu/linter-service/dispatches",
		);

		const dispatchBody = JSON.parse(
			(fetchMock.mock.calls[6]?.[1] as RequestInit).body as string,
		) as {
			client_payload: {
				event_name: string;
				signature: string;
				pull_request: {
					head: {
						ref: string;
					};
					number: number;
				};
				repository: {
					owner: {
						login: string;
					};
				};
			};
			event_type: string;
		};

		expect(dispatchBody.event_type).toBe("github_app_webhook");
		expect(dispatchBody.client_payload.event_name).toBe("pull_request");
		expect(dispatchBody.client_payload.pull_request.number).toBe(42);
		expect(dispatchBody.client_payload.pull_request.head.ref).toBe(
			"feature/example",
		);
		expect(dispatchBody.client_payload.repository.owner.login).toBe("acme");
		expectValidDispatchSignature(dispatchBody.client_payload);

		const queuedCheckBody = JSON.parse(
			(fetchMock.mock.calls[5]?.[1] as RequestInit).body as string,
		) as {
			details_url: string;
			external_id: string;
			head_sha: string;
			name: string;
			output: {
				summary: string;
				title: string;
			};
			status: string;
		};

		expect(queuedCheckBody).toEqual({
			details_url: "https://github.com/acme/source-repo/pull/42",
			external_id: "linter-service:42:abc123",
			head_sha: "abc123",
			name: "linter-service",
			output: {
				summary:
					"The linter-service workflow request is being queued and should start shortly.",
				title: "linter-service is queued",
			},
			status: "queued",
		});
	});

	it("normalizes custom GitHub API base URLs before calling upstream APIs", async () => {
		const fetchMock = vi.mocked(fetch);

		mockPullRequestDispatchAndQueuedCheck(fetchMock);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: {
						label: "acme:main",
						ref: "main",
						repo: {
							full_name: "acme/source-repo",
							html_url: "https://github.com/acme/source-repo",
							id: 10,
							name: "source-repo",
							owner: { id: 1, login: "acme", type: "Organization" },
							private: false,
						},
						sha: "def456",
					},
					draft: false,
					head: {
						label: "octocat:feature/example",
						ref: "feature/example",
						repo: {
							clone_url: "https://github.com/octocat/forked-repo.git",
							full_name: "octocat/forked-repo",
							html_url: "https://github.com/octocat/forked-repo",
							id: 11,
							name: "forked-repo",
							owner: { id: 2, login: "octocat", type: "User" },
							private: false,
						},
						sha: "abc123",
					},
					html_url: "https://github.com/acme/source-repo/pull/42",
					id: 42,
					merged: false,
					number: 42,
					state: "open",
					title: "Add feature",
					user: { id: 2, login: "octocat", type: "User" },
				},
				repository: {
					full_name: "acme/source-repo",
					html_url: "https://github.com/acme/source-repo",
					id: 10,
					name: "source-repo",
					owner: { id: 1, login: "acme", type: "Organization" },
					private: false,
				},
				sender: { id: 2, login: "octocat", type: "User" },
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, {
			...baseEnv,
			GITHUB_API_BASE_URL: "https://api.github.example.test/// \n",
		});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(7);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.example.test/repos/chalharu/linter-service/installation",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.example.test/app/installations/456/access_tokens",
		);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://api.github.example.test/repos/octocat/forked-repo/installation",
		);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(
			"https://api.github.example.test/app/installations/654/access_tokens",
		);
		expect(fetchMock.mock.calls[4]?.[0]).toBe(
			"https://api.github.example.test/repos/octocat/forked-repo/commits/abc123/check-runs?check_name=linter-service&page=1&per_page=100",
		);
		expect(fetchMock.mock.calls[5]?.[0]).toBe(
			"https://api.github.example.test/repos/octocat/forked-repo/check-runs",
		);
		expect(fetchMock.mock.calls[6]?.[0]).toBe(
			"https://api.github.example.test/repos/chalharu/linter-service/dispatches",
		);
	});

	it("rejects invalid custom GitHub API base URLs", async () => {
		const fetchMock = vi.mocked(fetch);
		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: {
						label: "acme:main",
						ref: "main",
						repo: {
							full_name: "acme/source-repo",
							html_url: "https://github.com/acme/source-repo",
							id: 10,
							name: "source-repo",
							owner: { id: 1, login: "acme", type: "Organization" },
							private: false,
						},
						sha: "def456",
					},
					draft: false,
					head: {
						label: "octocat:feature/example",
						ref: "feature/example",
						repo: {
							clone_url: "https://github.com/octocat/forked-repo.git",
							full_name: "octocat/forked-repo",
							html_url: "https://github.com/octocat/forked-repo",
							id: 11,
							name: "forked-repo",
							owner: { id: 2, login: "octocat", type: "User" },
							private: false,
						},
						sha: "abc123",
					},
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
					html_url: "https://github.com/acme/source-repo",
					id: 10,
					name: "source-repo",
					owner: { id: 1, login: "acme", type: "Organization" },
					private: false,
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, {
			...baseEnv,
			GITHUB_API_BASE_URL: "http://api.github.example.test",
		});
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(500);
		expect(responseJson.error).toBe(
			"GITHUB_API_BASE_URL must be a valid HTTPS URL",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips pull_request events for the dispatch target repository", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example", sha: "abc123" },
					number: 42,
				},
				repository: {
					full_name: "chalharu/linter-service",
					name: "linter-service",
					owner: { login: "chalharu", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"webhook events from the dispatch target repository are handled directly",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips pull_request actions that do not change lint routing inputs", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "labeled",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example", sha: "abc123" },
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			reason: string;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason: "pull_request action is not forwarded: labeled",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("dispatches pull_request edits when the base branch changes", async () => {
		const fetchMock = vi.mocked(fetch);

		mockPullRequestDispatchAndQueuedCheck(fetchMock);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "edited",
				changes: {
					base: {
						ref: {
							from: "main",
						},
					},
				},
				installation: { id: 987 },
				pull_request: {
					base: { ref: "release/1.x", sha: "def456" },
					head: {
						ref: "feature/example",
						repo: {
							full_name: "octocat/forked-repo",
							name: "forked-repo",
							owner: { login: "octocat", type: "User" },
						},
						sha: "abc123",
					},
					html_url: "https://github.com/acme/source-repo/pull/42",
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
					name: "source-repo",
					owner: { login: "acme", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			pull_request: { head_ref: string; number: number };
		}>();

		expect(response.status).toBe(200);
		expect(responseJson.dispatched).toBe(true);
		expect(responseJson.pull_request).toEqual({
			head_ref: "feature/example",
			head_sha: "abc123",
			number: 42,
		});
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it("updates an existing queued processing check instead of creating a duplicate", async () => {
		const fetchMock = vi.mocked(fetch);

		mockPullRequestDispatchAndQueuedCheck(fetchMock, {
			existingQueuedCheckRunId: 73,
		});

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: {
						ref: "feature/example",
						repo: {
							full_name: "acme/source-repo",
							name: "source-repo",
							owner: { login: "acme", type: "Organization" },
						},
						sha: "abc123",
					},
					html_url: "https://github.com/acme/source-repo/pull/42",
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
					name: "source-repo",
					owner: { login: "acme", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(7);
		expect(fetchMock.mock.calls[5]?.[0]).toBe(
			"https://api.github.com/repos/acme/source-repo/check-runs/73",
		);
		expect((fetchMock.mock.calls[5]?.[1] as RequestInit).method).toBe("PATCH");
	});

	it("scans multiple check-run pages before deciding to create a queued check", async () => {
		const fetchMock = vi.mocked(fetch);

		fetchMock
			.mockResolvedValueOnce(jsonResponse({ id: 456 }, 200))
			.mockResolvedValueOnce(
				jsonResponse({ token: "dispatcher-installation-token" }, 201),
			)
			.mockResolvedValueOnce(jsonResponse({ id: 654 }, 200))
			.mockResolvedValueOnce(
				jsonResponse({ token: "checker-installation-token" }, 201),
			)
			.mockResolvedValueOnce(
				jsonResponse(
					{
						check_runs: Array.from({ length: 100 }, (_, index) => ({
							external_id: `other-check:${index}`,
							id: index + 1,
						})),
					},
					200,
				),
			)
			.mockResolvedValueOnce(
				jsonResponse(
					{
						check_runs: [
							{
								external_id: "linter-service:42:abc123",
								id: 173,
							},
						],
					},
					200,
				),
			)
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: {
						ref: "feature/example",
						repo: {
							full_name: "acme/source-repo",
							name: "source-repo",
							owner: { login: "acme", type: "Organization" },
						},
						sha: "abc123",
					},
					html_url: "https://github.com/acme/source-repo/pull/42",
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
					name: "source-repo",
					owner: { login: "acme", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(8);
		expect(fetchMock.mock.calls[4]?.[0]).toBe(
			"https://api.github.com/repos/acme/source-repo/commits/abc123/check-runs?check_name=linter-service&page=1&per_page=100",
		);
		expect(fetchMock.mock.calls[5]?.[0]).toBe(
			"https://api.github.com/repos/acme/source-repo/commits/abc123/check-runs?check_name=linter-service&page=2&per_page=100",
		);
		expect(fetchMock.mock.calls[6]?.[0]).toBe(
			"https://api.github.com/repos/acme/source-repo/check-runs/173",
		);
		expect(fetchMock.mock.calls[7]?.[0]).toBe(
			"https://api.github.com/repos/chalharu/linter-service/dispatches",
		);
	});

	it("keeps dispatching when queued processing notification fails", async () => {
		const fetchMock = vi.mocked(fetch);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		fetchMock
			.mockResolvedValueOnce(jsonResponse({ id: 456 }, 200))
			.mockResolvedValueOnce(
				jsonResponse({ token: "dispatcher-installation-token" }, 201),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "missing installation" }), {
					headers: { "content-type": "application/json" },
					status: 404,
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: {
						ref: "feature/example",
						repo: {
							full_name: "acme/source-repo",
							name: "source-repo",
							owner: { login: "acme", type: "Organization" },
						},
						sha: "abc123",
					},
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
					name: "source-repo",
					owner: { login: "acme", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{ dispatched: boolean }>();

		expect(response.status).toBe(200);
		expect(responseJson.dispatched).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(consoleError).toHaveBeenCalled();
	});

	it("skips pull_request edits that do not change the base branch", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "edited",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example", sha: "abc123" },
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			reason: string;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason: "pull_request action is not forwarded: edited",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("dispatches default-branch push payloads with the dispatcher app", async () => {
		const fetchMock = vi.mocked(fetch);

		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 456 }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token: "dispatcher-installation-token" }),
					{
						headers: { "content-type": "application/json" },
						status: 201,
					},
				),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const request = createWebhookRequest(
			"push",
			{
				after: "abc123",
				before: "def456",
				created: false,
				deleted: false,
				forced: false,
				installation: { id: 987 },
				ref: "refs/heads/main",
				repository: {
					default_branch: "main",
					full_name: "acme/source-repo",
					html_url: "https://github.com/acme/source-repo",
					id: 10,
					name: "source-repo",
					owner: { id: 1, login: "acme", type: "Organization" },
					private: false,
				},
				sender: { id: 2, login: "octocat", type: "User" },
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			push: { default_branch: string; head_sha: string; ref: string };
		}>();

		expect(response.status).toBe(200);
		expect(responseJson.dispatched).toBe(true);
		expect(responseJson.push).toEqual({
			default_branch: "main",
			head_sha: "abc123",
			ref: "refs/heads/main",
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);

		const dispatchBody = JSON.parse(
			(fetchMock.mock.calls[2]?.[1] as RequestInit).body as string,
		) as {
			client_payload: {
				event_name: string;
				signature: string;
				push: {
					after: string;
					ref: string;
					ref_name: string;
				};
				repository: {
					default_branch: string;
				};
			};
			event_type: string;
		};

		expect(dispatchBody.event_type).toBe("github_app_webhook");
		expect(dispatchBody.client_payload.event_name).toBe("push");
		expect(dispatchBody.client_payload.push.after).toBe("abc123");
		expect(dispatchBody.client_payload.push.ref).toBe("refs/heads/main");
		expect(dispatchBody.client_payload.push.ref_name).toBe("main");
		expect(dispatchBody.client_payload.repository.default_branch).toBe("main");
		expectValidDispatchSignature(dispatchBody.client_payload);
	});

	it("skips push events outside the default branch", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"push",
			{
				after: "abc123",
				installation: { id: 987 },
				ref: "refs/heads/feature/example",
				repository: {
					default_branch: "main",
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			reason: string;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"push event is not forwarded: ref refs/heads/feature/example is not the default branch",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips pull-request-associated check_run events to avoid duplicate lint runs", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"check_run",
			{
				action: "completed",
				check_run: {
					conclusion: "success",
					head_sha: "abc123",
					id: 77,
					name: "ci / test",
					pull_requests: [{ number: 42 }],
					status: "completed",
				},
				installation: { id: 123 },
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			reason: string;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"check_run events are not forwarded because pull_request events are authoritative",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips check_run events generated by linter-service notifications", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"check_run",
			{
				action: "created",
				check_run: {
					external_id: "linter-service:42:abc123",
					head_sha: "abc123",
					id: 77,
					name: "linter-service / actionlint",
					pull_requests: [{ number: 42 }],
					status: "in_progress",
				},
				installation: { id: 123 },
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason: "check_run was generated by linter-service",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips check_run events for the dispatch target repository", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"check_run",
			{
				action: "completed",
				check_run: {
					head_sha: "abc123",
					id: 77,
					name: "ci / test",
					pull_requests: [{ number: 42 }],
					status: "completed",
				},
				installation: { id: 123 },
				repository: {
					full_name: "chalharu/linter-service",
					name: "linter-service",
					owner: { login: "chalharu", type: "Organization" },
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"webhook events from the dispatch target repository are handled directly",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips check_run events that are not tied to a pull request", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"check_run",
			{
				action: "created",
				check_run: {
					head_sha: "abc123",
					id: 77,
					name: "ci / test",
					pull_requests: [],
					status: "queued",
				},
				installation: { id: 123 },
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"check_run events are not forwarded because pull_request events are authoritative",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips check_run payloads with invalid pull request numbers", async () => {
		const fetchMock = vi.mocked(fetch);

		const request = createWebhookRequest(
			"check_run",
			{
				action: "created",
				check_run: {
					head_sha: "abc123",
					id: 77,
					name: "ci / test",
					pull_requests: [{ number: 0 }],
					status: "queued",
				},
				installation: { id: 123 },
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{
			dispatched: boolean;
			reason: string;
			skipped: boolean;
		}>();

		expect(response.status).toBe(202);
		expect(responseJson).toEqual({
			dispatched: false,
			ok: true,
			reason:
				"check_run events are not forwarded because pull_request events are authoritative",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sanitizes upstream GitHub API failures", async () => {
		const fetchMock = vi.mocked(fetch);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "Bad credentials" }), {
				headers: { "content-type": "application/json" },
				status: 401,
			}),
		);

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example" },
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(502);
		expect(responseJson.error).toBe(
			"failed to resolve dispatcher installation",
		);
		expect(consoleError).toHaveBeenCalled();
	});

	it("returns a JSON error when the dispatcher app key is invalid", async () => {
		const fetchMock = vi.mocked(fetch);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example" },
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
				},
			},
			baseEnv.GITHUB_CHECKER_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, {
			...baseEnv,
			GITHUB_DISPATCHER_APP_PRIVATE_KEY:
				"-----BEGIN RSA PRIVATE KEY-----\ninvalid\n-----END RSA PRIVATE KEY-----",
		});
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(500);
		expect(responseJson.error).toBe("failed to create dispatcher app JWT");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});

	it("rejects invalid webhook signatures", async () => {
		const request = createWebhookRequest(
			"pull_request",
			{
				action: "opened",
				installation: { id: 987 },
				pull_request: {
					base: { ref: "main" },
					head: { ref: "feature/example" },
					number: 42,
				},
				repository: {
					full_name: "acme/source-repo",
				},
			},
			"different-secret",
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(401);
		expect(responseJson.error).toBe("invalid webhook signature");
	});
});

function createWebhookRequest(
	eventName: string,
	payload: unknown,
	secret: string,
): Request {
	const body = JSON.stringify(payload);
	const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

	return new Request("https://example.com/", {
		body,
		headers: {
			"content-type": "application/json",
			"x-github-delivery": "delivery-123",
			"x-github-event": eventName,
			"x-hub-signature-256": signature,
		},
		method: "POST",
	});
}

function expectValidDispatchSignature(
	payload: { signature: string } & Record<string, unknown>,
): void {
	expect(payload.signature).toMatch(/^sha256=[a-f0-9]{64}$/u);
	expect(() => {
		verifyDispatchSignature({
			payloadJson: JSON.stringify(payload),
			secret: TEST_PRIVATE_KEY,
		});
	}).not.toThrow();
}

function mockPullRequestDispatchAndQueuedCheck(
	fetchMock: ReturnType<typeof vi.mocked<typeof fetch>>,
	options: {
		existingQueuedCheckRunId?: number;
	} = {},
) {
	const existingQueuedCheckRunId = options.existingQueuedCheckRunId ?? null;

	fetchMock
		.mockResolvedValueOnce(jsonResponse({ id: 456 }, 200))
		.mockResolvedValueOnce(
			jsonResponse({ token: "dispatcher-installation-token" }, 201),
		)
		.mockResolvedValueOnce(jsonResponse({ id: 654 }, 200))
		.mockResolvedValueOnce(
			jsonResponse({ token: "checker-installation-token" }, 201),
		)
		.mockResolvedValueOnce(
			jsonResponse(
				{
					check_runs:
						existingQueuedCheckRunId === null
							? []
							: [
									{
										external_id: "linter-service:42:abc123",
										id: existingQueuedCheckRunId,
									},
								],
				},
				200,
			),
		)
		.mockResolvedValueOnce(
			new Response(null, {
				status: existingQueuedCheckRunId === null ? 201 : 200,
			}),
		)
		.mockResolvedValueOnce(new Response(null, { status: 204 }));
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}
