#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/compose.sh" config --quiet
"${SCRIPT_DIR}/compose.sh" up -d
"${SCRIPT_DIR}/compose.sh" ps -a
