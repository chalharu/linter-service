import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/index";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY = privateKey
	.export({ format: "pem", type: "pkcs8" })
	.toString();

const baseEnv: Env = {
	GITHUB_APP_ID: "123456",
	GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
	GITHUB_DISPATCH_OWNER: "chalharu",
	GITHUB_DISPATCH_REPO: "linter-service",
	GITHUB_WEBHOOK_SECRET: "super-secret",
};

describe("github webhook proxy worker", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("dispatches normalized pull_request payloads", async () => {
		const fetchMock = vi.mocked(fetch);

		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "installation-token" }), {
					headers: { "content-type": "application/json" },
					status: 201,
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

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
			baseEnv.GITHUB_WEBHOOK_SECRET,
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
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/app/installations/987/access_tokens",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/repos/chalharu/linter-service/dispatches",
		);

		const dispatchBody = JSON.parse(
			(fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
		) as {
			client_payload: {
				event_name: string;
				pull_request: {
					head: {
						ref: string;
					};
					number: number;
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
	});

	it("resolves check_run pull requests and supports a dispatch installation override", async () => {
		const fetchMock = vi.mocked(fetch);
		const env: Env = {
			...baseEnv,
			GITHUB_DISPATCH_INSTALLATION_ID: "999",
		};

		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "source-installation-token" }), {
					headers: { "content-type": "application/json" },
					status: 201,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						base: {
							label: "acme:main",
							ref: "main",
							repo: {
								full_name: "acme/source-repo",
								id: 10,
								name: "source-repo",
								owner: { id: 1, login: "acme", type: "Organization" },
								private: false,
							},
							sha: "def456",
						},
						head: {
							label: "octocat:feature/example",
							ref: "feature/example",
							repo: {
								full_name: "octocat/forked-repo",
								id: 11,
								name: "forked-repo",
								owner: { id: 2, login: "octocat", type: "User" },
								private: false,
							},
							sha: "abc123",
						},
						id: 42,
						number: 42,
						title: "Add feature",
						user: { id: 2, login: "octocat", type: "User" },
					}),
					{
						headers: { "content-type": "application/json" },
						status: 200,
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: "dispatch-installation-token" }), {
					headers: { "content-type": "application/json" },
					status: 201,
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const request = createWebhookRequest(
			"check_run",
			{
				action: "completed",
				check_run: {
					app: { id: 12, name: "GitHub Actions", slug: "github-actions" },
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
					id: 10,
					name: "source-repo",
					owner: { id: 1, login: "acme", type: "Organization" },
					private: false,
				},
			},
			env.GITHUB_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, env);
		const responseJson = await response.json<{
			dispatched: boolean;
			pull_request: { head_ref: string; number: number };
		}>();

		expect(response.status).toBe(200);
		expect(responseJson.dispatched).toBe(true);
		expect(responseJson.pull_request.number).toBe(42);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://api.github.com/app/installations/123/access_tokens",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.github.com/repos/acme/source-repo/pulls/42",
		);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://api.github.com/app/installations/999/access_tokens",
		);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(
			"https://api.github.com/repos/chalharu/linter-service/dispatches",
		);

		const dispatchBody = JSON.parse(
			(fetchMock.mock.calls[3]?.[1] as RequestInit).body as string,
		) as {
			client_payload: {
				check_run: {
					name: string;
				};
				dispatch_installation_id: number;
				pull_request: {
					number: number;
				};
			};
		};

		expect(dispatchBody.client_payload.dispatch_installation_id).toBe(999);
		expect(dispatchBody.client_payload.pull_request.number).toBe(42);
		expect(dispatchBody.client_payload.check_run.name).toBe("ci / test");
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
			baseEnv.GITHUB_WEBHOOK_SECRET,
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
			reason: "check_run is not associated with a pull request",
			skipped: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects check_run payloads with invalid pull request numbers", async () => {
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
			baseEnv.GITHUB_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(400);
		expect(responseJson.error).toBe(
			"check_run payload must include a positive pull request number",
		);
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
			baseEnv.GITHUB_WEBHOOK_SECRET,
		);

		const response = await worker.fetch(request, baseEnv);
		const responseJson = await response.json<{ error: string }>();

		expect(response.status).toBe(502);
		expect(responseJson.error).toBe("failed to create installation token");
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
