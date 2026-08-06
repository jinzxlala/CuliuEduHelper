#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
BASE_COMPOSE_FILE="${REPOSITORY_ROOT}/infra/deploy/docker-compose.production.yml"

if [[ -n "${CULIU_DEPLOY_ENV_FILE:-}" ]]; then
  ENV_FILE="${CULIU_DEPLOY_ENV_FILE}"
elif [[ -f /srv/culiu/config/.env.production ]]; then
  ENV_FILE=/srv/culiu/config/.env.production
else
  ENV_FILE="${REPOSITORY_ROOT}/infra/deploy/.env.production"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'Production environment file not found: %s\n' "${ENV_FILE}" >&2
  printf 'Set CULIU_DEPLOY_ENV_FILE to the correct absolute path.\n' >&2
  exit 2
fi

COMPOSE_FILES=(-f "${BASE_COMPOSE_FILE}")
if [[ -n "${CULIU_DEPLOY_OVERRIDE_FILE:-}" ]]; then
  if [[ ! -f "${CULIU_DEPLOY_OVERRIDE_FILE}" ]]; then
    printf 'Compose override file not found: %s\n' "${CULIU_DEPLOY_OVERRIDE_FILE}" >&2
    exit 2
  fi
  COMPOSE_FILES+=(-f "${CULIU_DEPLOY_OVERRIDE_FILE}")
elif [[ -f /srv/culiu/config/docker-compose.tcr.yml ]]; then
  COMPOSE_FILES+=(-f /srv/culiu/config/docker-compose.tcr.yml)
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'docker was not found in PATH.\n' >&2
  exit 127
fi

exec docker compose --env-file "${ENV_FILE}" "${COMPOSE_FILES[@]}" "$@"
