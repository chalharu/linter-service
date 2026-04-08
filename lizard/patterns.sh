#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

node - "$script_dir/language-config.js" <<'NODE'
const helperPath = process.argv[2];
const { getAllPatternStrings } = require(helperPath);

for (const pattern of getAllPatternStrings()) {
	process.stdout.write(`${pattern}\n`);
}
NODE
