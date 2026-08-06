#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Stop containers without removing containers, networks, named volumes, or bind-mounted data.
"${SCRIPT_DIR}/compose.sh" stop "$@"
"${SCRIPT_DIR}/compose.sh" ps -a
