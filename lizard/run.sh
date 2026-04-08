#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
output_file="$RUNNER_TEMP/linter-output.txt"

run_lizard() {
  lizard -w "$@" | node -e '
const fs = require("node:fs");

const source = fs.readFileSync(0, "utf8");
const normalized = source
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const match =
      /^(?<path>.+?):(?<line>\d+): warning: (?<function>.+?) has (?<ccn>\d+) CCN\b/u.exec(
        line,
      );

    if (!match?.groups) {
      return line;
    }

    const filePath = match.groups.path.replace(/^\.\//u, "");
    return `${filePath}:${match.groups.line}: ${match.groups.function} exceeds the CCN limit with ${match.groups.ccn} CCN`;
  });

process.stdout.write(normalized.join("\n"));
'
}

linter_lib::run_and_emit_json "$output_file" run_lizard "$@"
