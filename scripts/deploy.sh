#!/usr/bin/env bash
# Pull (or build), backup, migrate and start. Safe for first deploy and redeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/ops-lib.sh"

load_env
preflight_common
assert_production_env
require_release_version

start_infra
provide_images
backup_before_migrations
run_migrations
start_apps
smoke_health

info "Deploy fertig. Version: $(image_tag)"
