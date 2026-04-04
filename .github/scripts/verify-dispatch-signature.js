const { createHmac, timingSafeEqual } = require("node:crypto");

const SIGNATURE_PREFIX = "sha256=";

function runFromEnv(env = process.env) {
	verifyDispatchSignature({
		payloadJson: requireEnv(env, "CLIENT_PAYLOAD_JSON"),
		secret: requireEnv(env, "CHECKER_PRIVATE_KEY"),
	});
}

function verifyDispatchSignature({ payloadJson, secret }) {
	const normalizedSecret = normalizeSecret(secret);
	let payload;

	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("CLIENT_PAYLOAD_JSON must be valid JSON");
	}

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("CLIENT_PAYLOAD_JSON must decode to an object");
	}

	const signature = payload.signature;

	if (typeof signature !== "string" || signature.length === 0) {
		throw new Error("repository_dispatch payload signature is required");
	}

	if (!signature.startsWith(SIGNATURE_PREFIX)) {
		throw new Error("repository_dispatch payload signature is malformed");
	}

	const unsignedPayload = { ...payload };
	delete unsignedPayload.signature;
	const expected = signDispatchPayload({
		payload: unsignedPayload,
		secret: normalizedSecret,
	});

	if (!safeCompare(signature, expected)) {
		throw new Error("repository_dispatch payload signature is invalid");
	}
}

function signDispatchPayload({ payload, secret }) {
	return `${SIGNATURE_PREFIX}${createHmac("sha256", normalizeSecret(secret))
		.update(stableStringify(payload))
		.digest("hex")}`;
}

function stableStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}

	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}

	return JSON.stringify(value);
}

function safeCompare(left, right) {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");

	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

function normalizeSecret(secret) {
	if (typeof secret !== "string") {
		throw new Error("CHECKER_PRIVATE_KEY is required");
	}

	const trimmedSecret = secret.trim();
	const unwrappedSecret =
		trimmedSecret.startsWith('"') && trimmedSecret.endsWith('"')
			? trimmedSecret.slice(1, -1)
			: trimmedSecret;
	const normalizedSecret = unwrappedSecret
		.replace(/\\r/g, "\r")
		.replace(/\\n/g, "\n")
		.replace(/\r\n?/g, "\n")
		.trim();

	if (normalizedSecret.length === 0) {
		throw new Error("CHECKER_PRIVATE_KEY is required");
	}

	return normalizedSecret;
}

function requireEnv(env, key) {
	const value = typeof env[key] === "string" ? env[key].trim() : "";

	if (value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

if (require.main === module) {
	runFromEnv(process.env);
}

module.exports = {
	runFromEnv,
	signDispatchPayload,
	stableStringify,
	verifyDispatchSignature,
};
