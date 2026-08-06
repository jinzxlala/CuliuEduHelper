#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TAIL_LINES="${CULIU_LOG_TAIL:-200}"

if [[ "$#" -eq 0 ]]; then
  set -- knowledge-web operations-web worker nginx
fi

exec "${SCRIPT_DIR}/compose.sh" logs --tail "${TAIL_LINES}" "$@"
