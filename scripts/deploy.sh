#!/usr/bin/env bash
# Build, migrate and start the current checkout. Safe for first deploy and redeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/ops-lib.sh"

load_env
preflight_common
assert_production_env

start_infra
build_images
run_migrations
start_apps
smoke_health

info "Deploy fertig. Version: $(image_tag)"
