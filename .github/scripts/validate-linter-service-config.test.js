const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const yaml = require("js-yaml");

const {
	validateLinterServiceConfig,
} = require("./validate-linter-service-config.js");

const repositoryRoot = path.join(__dirname, "..", "..");
const rootConfigPath = path.join(
	repositoryRoot,
	".github",
	"linter-service.yaml",
);
const rootSchemaPath = path.join(
	repositoryRoot,
	".github",
	"linter-service.schema.json",
);
const rootLintersPath = path.join(repositoryRoot, "linters.json");
const schemaDirective =
	"# yaml-language-server: $schema=./linter-service.schema.json";

function writeConfig(filePath, value, { withSchemaDirective = false } = {}) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const body = filePath.endsWith(".json")
		? JSON.stringify(value, null, 2)
		: yaml
				.dump(value, {
					lineWidth: -1,
					noRefs: true,
				})
				.trimEnd();
	const prefix = withSchemaDirective ? `${schemaDirective}\n` : "";
	fs.writeFileSync(filePath, `${prefix}${body}\n`, "utf8");
}

test("repository linter-service.yaml references and matches the schema", () => {
	const source = fs.readFileSync(rootConfigPath, "utf8");
	assert.match(
		source,
		/^# yaml-language-server: \$schema=\.\/linter-service\.schema\.json$/mu,
	);

	const report = validateLinterServiceConfig({
		configPath: rootConfigPath,
		schemaPath: rootSchemaPath,
	});

	assert.equal(report.configPath, rootConfigPath);
	assert.equal(report.schemaPath, rootSchemaPath);
});

test("supported linter names stay in sync with linters.json", () => {
	const schema = JSON.parse(fs.readFileSync(rootSchemaPath, "utf8"));
	const lintersConfig = JSON.parse(fs.readFileSync(rootLintersPath, "utf8"));
	const schemaNames = [...schema.$defs.knownLinterName.enum].sort();
	const configNames = Object.keys(lintersConfig.linters).sort();

	assert.deepEqual(schemaNames, configNames);
});

test("accepts supported linter-service config fields", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(
		configPath,
		{
			global: {
				exclude_paths: ["docs/generated/**"],
			},
			linters: {
				lizard: {
					disabled: false,
					languages: ["javascript", "typescript"],
				},
				textlint: {
					disabled: false,
					exclude_paths: ["docs/drafts/**"],
					preset_packages: ["textlint-rule-preset-ja-technical-writing@12.0.2"],
				},
				"cargo-coupling": {
					max_circular: 1,
					max_critical: 0,
					min_grade: "B",
				},
				yamllint: {
					disabled: true,
					exclude_paths: ["fixtures/**"],
				},
			},
		},
		{ withSchemaDirective: true },
	);

	try {
		assert.doesNotThrow(() =>
			validateLinterServiceConfig({
				configPath,
				schemaPath: rootSchemaPath,
			}),
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("accepts cargo-coupling quality gate thresholds", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			"cargo-coupling": {
				max_circular: 1,
				max_critical: 2,
				min_grade: "C",
			},
		},
	});

	try {
		const report = validateLinterServiceConfig({
			configPath,
			schemaPath: rootSchemaPath,
		});

		assert.deepEqual(report.normalizedConfig.linters["cargo-coupling"], {
			disabled: false,
			disabled_explicit: false,
			exclude_paths: [],
			max_circular: 1,
			max_critical: 2,
			min_grade: "C",
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unsupported cargo-coupling grades", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			"cargo-coupling": {
				min_grade: "Z",
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/allowed values|must be one of/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects negative cargo-coupling thresholds", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			"cargo-coupling": {
				max_critical: -1,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/must be >= 0|minimum/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unexpected linter properties", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			yamllint: {
				unknown_flag: true,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/unexpected property "unknown_flag"/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unknown linter names", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			yamllnit: {
				disabled: true,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/must be equal to one of the allowed values/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects explicitly enabled lizard without languages", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/languages/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unsupported lizard languages", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["brainfuck"],
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/allowed values|languages/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("accepts per-language lizard thresholds", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["javascript", "python"],
				thresholds: {
					javascript: {
						parameter_count: 6,
						length: 30,
					},
					python: {
						nloc: 10,
					},
				},
			},
		},
	});

	try {
		const report = validateLinterServiceConfig({
			configPath,
			schemaPath: rootSchemaPath,
		});

		assert.deepEqual(report.normalizedConfig.linters.lizard.thresholds, {
			javascript: {
				parameter_count: 6,
				length: 30,
			},
			python: {
				nloc: 10,
			},
		});
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unsupported lizard threshold languages", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["javascript"],
				thresholds: {
					brainfuck: {
						parameter_count: 4,
					},
				},
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/allowed values|must be one of/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unsupported lizard threshold metrics", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["javascript"],
				thresholds: {
					javascript: {
						foo: 1,
					},
				},
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/unexpected property|additional properties/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects lizard thresholds for languages outside linters.lizard.languages", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["javascript"],
				thresholds: {
					python: {
						parameter_count: 4,
					},
				},
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/languages must include every language configured in .*thresholds/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects negative lizard threshold values", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			lizard: {
				disabled: false,
				languages: ["javascript"],
				thresholds: {
					javascript: {
						parameter_count: -1,
					},
				},
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/must be >= 0|minimum/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects explicitly enabled textlint without preset_packages", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			textlint: {
				disabled: false,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/preset_packages/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects non-preset textlint package names", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: ["left-pad@1.3.0"],
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/textlint-rule-preset-|must use textlint preset packages/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects duplicate textlint preset package names", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "linter-service-schema-"),
	);
	const configPath = path.join(tempDir, "linter-service.yaml");

	writeConfig(configPath, {
		linters: {
			textlint: {
				disabled: false,
				preset_packages: [
					"textlint-rule-preset-ja-technical-writing@12.0.2",
					"textlint-rule-preset-ja-technical-writing@12.0.3",
				],
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLinterServiceConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/duplicate package names/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
