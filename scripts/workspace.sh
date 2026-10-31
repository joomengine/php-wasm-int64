#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
select_php "${1:-}"
printf '%s\n' "$UPSTREAM_DIRECTORY"
