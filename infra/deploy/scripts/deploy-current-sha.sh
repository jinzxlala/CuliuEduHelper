#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"

cd "${REPOSITORY_ROOT}"

if ! command -v git >/dev/null 2>&1; then
  printf 'git was not found in PATH.\n' >&2
  exit 127
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf 'Tracked files contain uncommitted changes; refusing to deploy an ambiguous release.\n' >&2
  exit 2
fi

RELEASE_SHA="$(git rev-parse --verify HEAD)"
if [[ ! "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'HEAD is not a full 40-character Git commit SHA.\n' >&2
  exit 2
fi

export CULIU_IMAGE_TAG="${RELEASE_SHA}"
export CULIU_GIT_COMMIT_SHA="${RELEASE_SHA}"

printf 'Deploying immutable release %s\n' "${RELEASE_SHA}"
"${SCRIPT_DIR}/compose.sh" config --quiet

# Only application images are pulled here. PostgreSQL, Redis, Nginx and the
# preloaded Meilisearch image remain pinned by the production Compose files.
"${SCRIPT_DIR}/compose.sh" pull migrate knowledge-web operations-web worker
"${SCRIPT_DIR}/compose.sh" up -d --remove-orphans
"${SCRIPT_DIR}/compose.sh" ps -a

printf '\nRelease %s has been submitted to Docker Compose.\n' "${RELEASE_SHA}"
printf 'Verify readiness and logs before announcing completion.\n'
