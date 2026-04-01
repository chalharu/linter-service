module.exports = async function upsertCheckRun({ github, env }) {
	const owner = env.CHECK_RUN_OWNER;
	const repo = env.CHECK_RUN_REPO;
	const headSha = env.CHECK_RUN_HEAD_SHA;
	const externalId = env.CHECK_RUN_EXTERNAL_ID;
	const name = env.CHECK_RUN_NAME;
	const status = env.CHECK_RUN_STATUS;
	const conclusion = env.CHECK_RUN_CONCLUSION;
	const detailsUrl =
		env.CHECK_RUN_DETAILS_URL ||
		`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
	const output = {
		title: env.CHECK_RUN_OUTPUT_TITLE,
		summary: env.CHECK_RUN_OUTPUT_SUMMARY,
	};
	const now = new Date().toISOString();
	const checkRuns = await github.paginate(
		github.rest.checks.listForRef,
		{
			owner,
			repo,
			ref: headSha,
			per_page: 100,
		},
		(response) => response.data.check_runs,
	);
	const existing = checkRuns.find(
		(checkRun) => checkRun && checkRun.external_id === externalId,
	);

	if (existing) {
		const updateRequest = {
			owner,
			repo,
			check_run_id: existing.id,
			details_url: detailsUrl,
			external_id: externalId,
			output,
			status,
		};

		if (status === "completed") {
			updateRequest.completed_at = now;
			updateRequest.conclusion = conclusion;
		}

		await github.rest.checks.update(updateRequest);
		return;
	}

	const createRequest = {
		owner,
		repo,
		name,
		head_sha: headSha,
		status,
		details_url: detailsUrl,
		external_id: externalId,
		started_at: now,
		output,
	};

	if (status === "completed") {
		createRequest.completed_at = now;
		createRequest.conclusion = conclusion;
	}

	await github.rest.checks.create(createRequest);
};
