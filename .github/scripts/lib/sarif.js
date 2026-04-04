const TOOL_URI = "https://github.com/chalharu/linter-service";

function buildSarifEnvelope({ category, results, rules, toolName }) {
	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				automationDetails: {
					id: category,
				},
				results,
				tool: {
					driver: {
						informationUri: TOOL_URI,
						name: toolName,
						rules,
					},
				},
			},
		],
	};
}

module.exports = {
	buildSarifEnvelope,
	TOOL_URI,
};
