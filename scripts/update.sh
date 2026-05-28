#!/usr/bin/env bash
# Pull latest code, backup, migrate, rebuild and restart app services.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/ops-lib.sh"

load_env
preflight_common
assert_production_env
require_cmd git

info "Code aktualisieren"
cd "$ROOT"
git fetch origin
git merge --ff-only "${TAXTRONIK_UPDATE_REF:-origin/main}"

load_env
preflight_common
assert_production_env

start_infra
run_backup
build_images
run_migrations
start_apps
smoke_health

info "Update fertig. Version: $(image_tag)"
