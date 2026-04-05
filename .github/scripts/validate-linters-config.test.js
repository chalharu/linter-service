const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateLintersConfig } = require("./validate-linters-config.js");

const repositoryRoot = path.join(__dirname, "..", "..");
const rootConfigPath = path.join(repositoryRoot, "linters.json");
const rootSchemaPath = path.join(repositoryRoot, "linters.schema.json");

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		`${filePath}`,
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

function writeText(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, value, "utf8");
}

test("accepts the repository linters.json", () => {
	const report = validateLintersConfig({
		configPath: rootConfigPath,
		schemaPath: rootSchemaPath,
	});

	assert.equal(report.configPath, rootConfigPath);
	assert.equal(report.schemaPath, rootSchemaPath);
});

test("accepts supported optional linter metadata", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeJson(configPath, {
		$schema: "./linters.schema.json",
		linters: {
			example: {
				default_disabled: true,
				execution_group: "yaml-fast",
				isolated: true,
				required_root_files: [".example.yml"],
				sarif: {
					category: "custom/example",
					default_level: "warning",
					enabled: true,
					tool_name: "custom-example",
				},
			},
		},
	});

	try {
		assert.doesNotThrow(() =>
			validateLintersConfig({
				configPath,
				schemaPath: rootSchemaPath,
			}),
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unsupported SARIF default levels", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeJson(configPath, {
		linters: {
			example: {
				sarif: {
					default_level: "info",
					enabled: true,
				},
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLintersConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/default_level/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects unexpected linter properties", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeJson(configPath, {
		linters: {
			example: {
				unknown_flag: true,
			},
		},
	});

	try {
		assert.throws(
			() =>
				validateLintersConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/unexpected property "unknown_flag"/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects duplicate linter object keys in raw JSON", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeText(
		configPath,
		`{
  "linters": {
    "example": {},
    "example": {
      "isolated": true
    }
  }
}
`,
	);

	try {
		assert.throws(
			() =>
				validateLintersConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/duplicate object key/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects duplicate top-level linters keys in raw JSON", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeText(
		configPath,
		`{
  "linters": {
    "alpha": {}
  },
  "linters": {
    "beta": {}
  }
}
`,
	);

	try {
		assert.throws(
			() =>
				validateLintersConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/\/linters/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("rejects legacy array-shaped linters definitions", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeJson(configPath, {
		linters: [
			{
				name: "example",
			},
		],
	});

	try {
		assert.throws(
			() =>
				validateLintersConfig({
					configPath,
					schemaPath: rootSchemaPath,
				}),
			/\/linters: must be object/u,
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});

test("accepts linters.json files that omit the schema association", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "linters-schema-"));
	const configPath = path.join(tempDir, "linters.json");

	writeJson(configPath, {
		linters: {
			example: {},
		},
	});

	try {
		assert.doesNotThrow(() =>
			validateLintersConfig({
				configPath,
				schemaPath: rootSchemaPath,
			}),
		);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
});
