#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./common.sh
source "$script_dir/common.sh"

pattern='^(?!.*(?:^|/)(?:\.git|\.jj|node_modules|target|\.yarn)(?:/|$))'
pattern+='(?!.*(?:^|/)(?:Cargo\.lock|composer\.lock|Gemfile\.lock|Pipfile\.lock|'
pattern+='npm-shrinkwrap\.json|package-lock\.json|pnpm-lock\.yaml|poetry\.lock|'
pattern+='uv\.lock|yarn\.lock|go\.(?:mod|sum|work|work\.sum)|'
pattern+='gradle/wrapper/gradle-wrapper\.properties|gradlew(?:\.bat)?|'
pattern+='(?:buildscript-)?gradle\.lockfile?|'
pattern+='\.mvn/wrapper/maven-wrapper\.properties|'
pattern+='\.mvn/wrapper/MavenWrapperDownloader\.java|mvnw(?:\.cmd)?|'
pattern+='\.terraform\.lock\.hcl|\.pnp\.c?js|\.pnp\.loader\.mjs)$)'
pattern+='(?!.*\.(?:7z|avif|bak|bin|bz2|docx?|eot|exe|gif|gz|ico|jar|jpe?g|log|'
pattern+='mp4|otf|p[bgnp]m|patch|pdf|png|snap|svg|tar|tgz|tiff?|ttf|war|webp|'
pattern+='wmv|woff2?|xlsx?|zip)$)'
pattern+='(?!.*\.(?:css|js)\.map$)(?!.*min\.(?:css|js)$).+'
printf '%s\n' "$pattern"
