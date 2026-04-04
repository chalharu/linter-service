const assert = require("node:assert/strict");
const test = require("node:test");

const {
	signDispatchPayload,
	verifyDispatchSignature,
} = require("./verify-dispatch-signature.js");

test("verifyDispatchSignature accepts a matching payload signature", () => {
	const payload = {
		delivery_id: "delivery-123",
		event_name: "push",
		push: {
			after: "abc123",
			ref: "refs/heads/main",
		},
		repository: {
			full_name: "acme/service-repo",
		},
	};
	const secret = "super-secret";
	const signedPayload = {
		...payload,
		signature: signDispatchPayload({ payload, secret }),
	};

	assert.doesNotThrow(() => {
		verifyDispatchSignature({
			payloadJson: JSON.stringify(signedPayload),
			secret,
		});
	});
});

test("verifyDispatchSignature rejects payload tampering", () => {
	const secret = "super-secret";
	const payload = {
		delivery_id: "delivery-123",
		event_name: "pull_request",
		pull_request: {
			number: 42,
		},
		repository: {
			full_name: "acme/source-repo",
		},
	};
	const signedPayload = {
		...payload,
		signature: signDispatchPayload({ payload, secret }),
	};
	signedPayload.repository.full_name = "attacker/other-repo";

	assert.throws(
		() =>
			verifyDispatchSignature({
				payloadJson: JSON.stringify(signedPayload),
				secret,
			}),
		/repository_dispatch payload signature is invalid/u,
	);
});

test("verifyDispatchSignature trims the shared secret like the worker", () => {
	const payload = {
		delivery_id: "delivery-123",
		event_name: "push",
		repository: {
			full_name: "acme/service-repo",
		},
	};
	const secret = "super-secret";
	const signedPayload = {
		...payload,
		signature: signDispatchPayload({ payload, secret }),
	};

	assert.doesNotThrow(() => {
		verifyDispatchSignature({
			payloadJson: JSON.stringify(signedPayload),
			secret: `${secret}\n`,
		});
	});
});

test("verifyDispatchSignature accepts multiline secrets in quoted env format", () => {
	const payload = {
		delivery_id: "delivery-123",
		event_name: "push",
		repository: {
			full_name: "acme/service-repo",
		},
	};
	const secret =
		"-----BEGIN RSA PRIVATE KEY-----\r\nline-one\r\nline-two\r\n-----END RSA PRIVATE KEY-----";
	const signedPayload = {
		...payload,
		signature: signDispatchPayload({ payload, secret }),
	};

	assert.doesNotThrow(() => {
		verifyDispatchSignature({
			payloadJson: JSON.stringify(signedPayload),
			secret: JSON.stringify(secret),
		});
	});
});
