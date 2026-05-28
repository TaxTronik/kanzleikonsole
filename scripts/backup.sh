#!/usr/bin/env bash
# One-command Postgres backup into the configured object-store backup bucket.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/ops-lib.sh"

load_env
preflight_common
assert_production_env
run_backup
info "Backup fertig."
