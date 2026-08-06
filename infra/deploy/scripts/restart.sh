#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$#" -eq 0 ]]; then
  set -- knowledge-web operations-web worker nginx
fi

"${SCRIPT_DIR}/compose.sh" restart "$@"
"${SCRIPT_DIR}/compose.sh" ps -a
