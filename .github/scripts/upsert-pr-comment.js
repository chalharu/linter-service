const fs = require("node:fs");

module.exports = async function upsertPullRequestComment({ github, env }) {
	const marker = requireEnv(env, "COMMENT_MARKER");
	const owner = requireEnv(env, "PR_OWNER");
	const repo = requireEnv(env, "PR_REPO");
	const issueNumber = parseIssueNumber(env.PR_NUMBER);
	const body = resolveCommentBody(env, marker);

	const comments = await github.paginate(github.rest.issues.listComments, {
		owner,
		repo,
		issue_number: issueNumber,
		per_page: 100,
	});
	const markerComments = comments
		.filter(
			(comment) =>
				comment &&
				typeof comment.id === "number" &&
				typeof comment.body === "string" &&
				comment.body.includes(marker),
		)
		.sort(compareComments);

	if (markerComments.length === 0) {
		await github.rest.issues.createComment({
			owner,
			repo,
			issue_number: issueNumber,
			body,
		});
		return;
	}

	const [primaryComment, ...duplicateComments] = markerComments;

	await github.rest.issues.updateComment({
		owner,
		repo,
		comment_id: primaryComment.id,
		body,
	});

	for (const duplicateComment of duplicateComments) {
		await github.rest.issues.deleteComment({
			owner,
			repo,
			comment_id: duplicateComment.id,
		});
	}
};

function requireEnv(env, key) {
	const value = env[key];

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${key} is required`);
	}

	return value;
}

function parseIssueNumber(rawValue) {
	const issueNumber = Number(rawValue);

	if (!Number.isInteger(issueNumber) || issueNumber < 1) {
		throw new Error("PR_NUMBER must be a positive integer");
	}

	return issueNumber;
}

function resolveCommentBody(env, marker) {
	if (typeof env.COMMENT_BODY === "string" && env.COMMENT_BODY.length > 0) {
		return env.COMMENT_BODY;
	}

	if (
		typeof env.COMMENT_FILE === "string" &&
		env.COMMENT_FILE.length > 0 &&
		fs.existsSync(env.COMMENT_FILE)
	) {
		return fs.readFileSync(env.COMMENT_FILE, "utf8");
	}

	return [
		marker,
		"## linter-service",
		"",
		"❌ The linter-service workflow failed to generate a combined report. See the workflow logs.",
		"",
	].join("\n");
}

function compareComments(left, right) {
	const createdAtDelta = compareCreatedAt(left?.created_at, right?.created_at);

	if (createdAtDelta !== 0) {
		return createdAtDelta;
	}

	return left.id - right.id;
}

function compareCreatedAt(leftValue, rightValue) {
	const leftTime = Date.parse(leftValue ?? "");
	const rightTime = Date.parse(rightValue ?? "");
	const leftIsValid = Number.isFinite(leftTime);
	const rightIsValid = Number.isFinite(rightTime);

	if (leftIsValid && rightIsValid && leftTime !== rightTime) {
		return leftTime - rightTime;
	}

	if (leftIsValid !== rightIsValid) {
		return leftIsValid ? -1 : 1;
	}

	return 0;
}
