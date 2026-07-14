#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../ops-lib.sh
source "$REPO_ROOT/scripts/ops-lib.sh"
NODE_BIN="$(command -v node 2>/dev/null || command -v node.exe)"

node_host() {
  local args=() arg
  for arg in "$@"; do
    if [[ "$NODE_BIN" == *.exe && "$arg" == /* ]]; then args+=("$(wslpath -w "$arg")")
    else args+=("$arg"); fi
  done
  "$NODE_BIN" "${args[@]}"
}

TESTS_RUN=0

test_fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" needle="$2"
  grep -Fq "$needle" "$file" || {
    printf '--- %s ---\n' "$file" >&2
    sed -n '1,220p' "$file" >&2
    test_fail "expected output to contain: $needle"
  }
}

assert_not_exists_or_empty() {
  local file="$1"
  [[ ! -e "$file" || ! -s "$file" ]] || {
    printf '--- %s ---\n' "$file" >&2
    cat "$file" >&2
    test_fail "expected file to be absent or empty: $file"
  }
}

assert_not_contains() {
  local file="$1" needle="$2"
  if [[ -f "$file" ]] && grep -Fq "$needle" "$file"; then
    printf '%s\n' "--- $file ---" >&2
    cat "$file" >&2
    test_fail "expected output not to contain: $needle"
  fi
}

assert_key_equals() {
  local file="$1" key="$2" expected="$3" actual
  actual="$(grep -E "^${key}=" "$file" | head -n1 | cut -d= -f2- || true)"
  [[ "$actual" == "$expected" ]] || {
    printf '%s\n' "--- $file ---" >&2
    cat "$file" >&2
    test_fail "expected ${key}=${expected}, got ${actual}"
  }
}

assert_file_equals() {
  local file="$1" expected="$2" actual
  actual="$(cat "$file" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || {
    printf '%s\n' "--- $file ---" >&2
    [[ -f "$file" ]] && cat "$file" >&2
    test_fail "expected file content '${expected}', got '${actual}'"
  }
}

assert_before() {
  local file="$1" first="$2" second="$3" first_line second_line
  first_line="$(grep -nF "$first" "$file" | head -n1 | cut -d: -f1 || true)"
  second_line="$(grep -nF "$second" "$file" | head -n1 | cut -d: -f1 || true)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] || {
    printf '%s\n' "--- $file ---" >&2
    cat "$file" >&2
    test_fail "expected '$first' before '$second'"
  }
}

file_mode() {
  local file="$1"
  if stat -c '%a' "$file" >/dev/null 2>&1; then stat -c '%a' "$file"
  else stat -f '%Lp' "$file"
  fi
}

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf 'ok %s - %s\n' "$TESTS_RUN" "$1"
}

write_prod_env() {
  local file="$1"
  cat >"$file" <<'EOF'
NODE_ENV=production
TAXTRONIK_VERSION=2026.06.17-test
AUTH_SECRET=auth-secret-with-at-least-thirty-two-chars
SECRET_BOX_KEY=secret-box-key-with-at-least-thirty-two-chars
N8N_HMAC_SECRET=n8n-hmac-secret-with-at-least-thirty-two-chars
N8N_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaa
POSTGRES_PASSWORD=postgres-password-24chars
TAXTRONIK_APP_PASSWORD=app-password-24chars-long
S3_ACCESS_KEY=prod-access-key
S3_SECRET_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
N8N_DB_PASSWORD=n8n-db-password-24chars
DATABASE_URL=postgresql://taxtronik:owner@localhost:5432/taxtronik?schema=public
DATABASE_APP_URL=postgresql://taxtronik_app:app@localhost:5432/taxtronik?schema=public
NEXTAUTH_URL=https://kanzlei.example.de
NEXTAUTH_TRUST_HOST=true
TRUST_PROXY_REQUIRED=true
SMTP_HOST=smtp.example.de
SMTP_PORT=587
SMTP_FROM=TaxTronik <noreply@example.de>
EOF
}

run_doctor_with_env() {
  local env_file="$1" output="$2"
  (
    unset AUTH_SECRET SECRET_BOX_KEY N8N_HMAC_SECRET N8N_ENCRYPTION_KEY POSTGRES_PASSWORD
    unset TAXTRONIK_APP_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY N8N_DB_PASSWORD
    unset DATABASE_URL DATABASE_APP_URL NODE_ENV TAXTRONIK_VERSION NEXTAUTH_URL
    unset NEXTAUTH_TRUST_HOST TRUST_PROXY_REQUIRED RISK_LAYER_URL RISK_LAYER_TOKEN SMTP_HOST SMTP_PORT
    unset SMTP_FROM PORTAL_PUBLIC_URL STAFF_COOKIE_DOMAIN PORTAL_COOKIE_DOMAIN
    ENVFILE="$env_file"
    # Unit-Test darf nicht vom zufällig vorhandenen lokalen Docker-Volume
    # beziehungsweise dessen echtem n8n-Key abhängen.
    _doctor_n8n_volume_key() { :; }
    doctor
  ) >"$output" 2>&1
}

test_doctor_accepts_prod_smtp() {
  local env_file="$TMP_DIR/prod.env" out="$TMP_DIR/doctor-ok.out"
  write_prod_env "$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected a valid prod SMTP config"
  }
  assert_contains "$out" "OK       SMTP_HOST"
  assert_contains "$out" "Bereit zum Deploy"
  pass "doctor accepts real production SMTP"
}

test_doctor_rejects_mailhog() {
  local env_file="$TMP_DIR/mailhog.env" out="$TMP_DIR/doctor-mailhog.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" SMTP_HOST mailhog
  set_env_file_value "$env_file" SMTP_PORT 1025
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted Mailhog in production"
  fi
  assert_contains "$out" "Dev-Mailhog-Default (mailhog:1025)"
  pass "doctor rejects Mailhog in production"
}

test_doctor_rejects_loopback_mailhog_port() {
  local env_file="$TMP_DIR/loopback.env" out="$TMP_DIR/doctor-loopback.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" SMTP_HOST 127.0.0.1
  set_env_file_value "$env_file" SMTP_PORT 1025
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted loopback Mailhog port in production"
  fi
  assert_contains "$out" "Dev-Mailhog-Default (127.0.0.1:1025)"
  pass "doctor rejects loopback:1025 in production"
}

test_doctor_rejects_disabled_auth_host_trust() {
  local env_file="$TMP_DIR/auth-host.env" out="$TMP_DIR/doctor-auth-host.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" NEXTAUTH_TRUST_HOST false
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted NEXTAUTH_TRUST_HOST=false although Auth.js rejects it"
  fi
  assert_contains "$out" "in Prod exakt true"
  pass "doctor rejects disabled Auth.js host trust in production"
}

test_doctor_accepts_internal_risk_layer_without_fetch_allowlist() {
  local env_file="$TMP_DIR/risk.env" out="$TMP_DIR/doctor-risk.out"
  write_prod_env "$env_file"
  {
    printf 'RISK_LAYER_URL=http://10.10.0.42:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor rejected trusted internal Risk-Layer URL"
  assert_contains "$out" "OK       RISK_LAYER"
  pass "doctor accepts internal Risk-Layer URL without INTERNAL_FETCH_HOSTS"
}

test_doctor_rejects_incomplete_risk_layer_pair() {
  local env_file="$TMP_DIR/risk-missing-token.env" out="$TMP_DIR/doctor-risk-missing.out"
  write_prod_env "$env_file"
  printf 'RISK_LAYER_URL=http://risk-layer:8000\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted Risk-Layer URL without token"
  fi
  assert_contains "$out" "RISK_LAYER_TOKEN"
  pass "doctor rejects incomplete Risk-Layer config"
}

set_env_file_value() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i -E "s|^${key}=.*$|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

fake_docker_path() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat >"$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
exit "${DOCKER_EXIT:-0}"
EOF
  chmod +x "$bin_dir/docker"
  : >"$log_file"
}

test_prune_build_cache_calls_docker_builder_prune() {
  local bin_dir="$TMP_DIR/bin-prune" log_file="$TMP_DIR/docker-prune.log" out="$TMP_DIR/prune.out"
  fake_docker_path "$bin_dir" "$log_file"
  PATH="$bin_dir:$PATH" DOCKER_LOG="$log_file" TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL=336h \
    prune_build_cache >"$out" 2>&1
  assert_contains "$log_file" "builder prune --force --filter until=336h"
  pass "build cache prune calls docker builder prune with configured age"
}

test_prune_build_cache_can_be_disabled() {
  local bin_dir="$TMP_DIR/bin-prune-off" log_file="$TMP_DIR/docker-prune-off.log" out="$TMP_DIR/prune-off.out"
  fake_docker_path "$bin_dir" "$log_file"
  PATH="$bin_dir:$PATH" DOCKER_LOG="$log_file" TAXTRONIK_BUILD_CACHE_PRUNE=off \
    prune_build_cache >"$out" 2>&1
  assert_not_exists_or_empty "$log_file"
  assert_contains "$out" "TAXTRONIK_BUILD_CACHE_PRUNE=off"
  pass "build cache prune can be disabled"
}

test_prune_build_cache_failure_is_non_blocking() {
  local bin_dir="$TMP_DIR/bin-prune-fail" log_file="$TMP_DIR/docker-prune-fail.log" out="$TMP_DIR/prune-fail.out"
  fake_docker_path "$bin_dir" "$log_file"
  PATH="$bin_dir:$PATH" DOCKER_LOG="$log_file" DOCKER_EXIT=17 \
    prune_build_cache >"$out" 2>&1 || test_fail "prune_build_cache must not fail the deploy"
  assert_contains "$out" "konnte nicht bereinigt werden"
  pass "build cache prune failure is non-blocking"
}

test_restore_source_detection_uses_s3_for_bucket_sources() {
  restore_needs_s3 --list || test_fail "restore --list should require S3"
  restore_needs_s3 --latest --target-url postgresql://example/db || test_fail "restore --latest should require S3"
  restore_needs_s3 --key pgdump/demo.dump || test_fail "restore --key should require S3"
  pass "restore source detection requires S3 for list/latest/key"
}

test_restore_source_detection_skips_s3_for_local_file() {
  if restore_needs_s3 --file "$TMP_DIR/demo.dump" --target-url postgresql://example/db; then
    test_fail "restore --file should not require S3"
  fi
  pass "restore source detection skips S3 for local files"
}

test_restore_validation_requires_explicit_target() {
  local out="$TMP_DIR/restore-missing-target.out"
  if (validate_restore_args --latest) >"$out" 2>&1; then
    test_fail "restore validation accepted a mutating call without explicit target"
  fi
  assert_contains "$out" "Genau ein Restore-Ziel ist Pflicht"
  pass "restore validation requires an explicit target"
}

test_restore_validation_rejects_unknown_and_conflicting_args() {
  local unknown="$TMP_DIR/restore-unknown.out" conflict="$TMP_DIR/restore-conflict.out"
  if (validate_restore_args --latest --target-url postgresql://example/db --unknown) >"$unknown" 2>&1; then
    test_fail "restore validation accepted an unknown option"
  fi
  assert_contains "$unknown" "Unbekannte Restore-Option"

  if (
    validate_restore_args --latest --key pgdump/demo.dump \
      --target-url postgresql://example/db
  ) >"$conflict" 2>&1; then
    test_fail "restore validation accepted conflicting sources"
  fi
  assert_contains "$conflict" "Genau eine Restore-Quelle ist Pflicht"
  pass "restore validation rejects unknown and conflicting arguments"
}

test_restore_list_does_not_change_service_state() {
  local sequence="$TMP_DIR/restore-list.sequence"
  : >"$sequence"
  (
    record_step() { printf '%s\n' "$*" >>"$sequence"; }
    load_env() { record_step load-env; }
    preflight_common() { record_step preflight; }
    assert_production_env() { record_step assert-production; }
    start_infra() { record_step start-infra; }
    compose() { record_step "compose $*"; }
    run_restore() { record_step "run-restore $*"; }
    cmd_restore --list
  ) >/dev/null 2>&1 || test_fail "read-only restore list failed"

  assert_contains "$sequence" "run-restore --list"
  assert_not_contains "$sequence" "start-infra"
  assert_not_contains "$sequence" "compose stop"
  pass "restore list remains read-only and does not start or stop services"
}

test_production_restore_requires_exact_confirmation_before_side_effects() {
  local sequence="$TMP_DIR/restore-prod-reject.sequence" out="$TMP_DIR/restore-prod-reject.out"
  : >"$sequence"
  if (
    load_env() { printf '%s\n' load-env >>"$sequence"; }
    start_infra() { printf '%s\n' start-infra >>"$sequence"; }
    compose() { printf '%s\n' "compose $*" >>"$sequence"; }
    run_restore() { printf '%s\n' run-restore >>"$sequence"; }
    cmd_restore --latest --production-target --confirm-production-restore yes \
      --release-version 1.0.0 --confirm-overwrite
  ) >"$out" 2>&1; then
    test_fail "production restore accepted a weak confirmation"
  fi

  assert_contains "$out" "$PRODUCTION_RESTORE_CONFIRMATION"
  assert_not_exists_or_empty "$sequence"
  pass "production restore rejects weak confirmation before side effects"
}

test_production_restore_stops_writers_and_leaves_them_stopped() {
  local sequence="$TMP_DIR/restore-prod.sequence"
  : >"$sequence"
  (
    record_step() { printf '%s\n' "$*" >>"$sequence"; }
    load_env() { record_step load-env; }
    preflight_common() { record_step preflight; }
    assert_production_env() { record_step assert-production; }
    start_infra() { record_step start-infra; }
    wait_postgres_healthy() { record_step wait-postgres; }
    wait_seaweedfs_healthy() { record_step wait-seaweedfs; }
    sync_postgres_roles_from_env() { record_step sync-roles; }
    compose() { record_step "compose $*"; }
    docker() {
      if [[ "${1:-}" == "inspect" ]]; then printf 'false\n'; return 0; fi
      record_step "docker $*"
    }
    run_restore() {
      record_step "run-restore quiesced=${TAXTRONIK_PRODUCTION_RESTORE_QUIESCED:-0} $*"
    }
    begin_database_restore_authorization() { record_step "begin-authorize $*"; }
    authorize_database_restore_release() { record_step "authorize-release $*"; }
    cmd_restore --latest --production-target \
      --confirm-production-restore "$PRODUCTION_RESTORE_CONFIRMATION" \
      --release-version 1.0.0 \
      --confirm-overwrite
  ) >/dev/null 2>&1 || test_fail "confirmed production restore failed"

  assert_before "$sequence" "begin-authorize 1.0.0" "compose stop app worker n8n"
  assert_before "$sequence" "compose stop app worker n8n" "run-restore quiesced=1"
  assert_contains "$sequence" "run-restore quiesced=1 --latest --production-target"
  assert_contains "$sequence" "authorize-release 1.0.0"
  assert_not_contains "$sequence" "start-apps"
  assert_not_contains "$sequence" "compose start"
  assert_not_contains "$sequence" "compose up"
  pass "production restore quiesces writers and never restarts them"
}

test_failed_production_restore_also_leaves_writers_stopped() {
  local sequence="$TMP_DIR/restore-prod-fail.sequence" out="$TMP_DIR/restore-prod-fail.out"
  local marker="$TMP_DIR/restore-prod-fail.authorization" guard_out="$TMP_DIR/restore-prod-fail.guard.out"
  : >"$sequence"
  if (
    DB_RESTORE_AUTHORIZATION="$marker"
    MIGRATION_PENDING="$TMP_DIR/restore-prod-fail.no-migration"
    record_step() { printf '%s\n' "$*" >>"$sequence"; }
    load_env() { :; }
    preflight_common() { :; }
    assert_production_env() { :; }
    start_infra() { :; }
    wait_postgres_healthy() { :; }
    wait_seaweedfs_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    compose() { record_step "compose $*"; }
    docker() {
      [[ "${1:-}" == "inspect" ]] && { printf 'false\n'; return 0; }
      return 0
    }
    run_restore() { record_step run-restore-failed; return 17; }
    authorize_database_restore_release() { test_fail "failed restore must not authorize a release"; }
    cmd_restore --latest --production-target \
      --confirm-production-restore "$PRODUCTION_RESTORE_CONFIRMATION" \
      --release-version 1.0.0 \
      --confirm-overwrite
  ) >"$out" 2>&1; then
    test_fail "failed production restore unexpectedly succeeded"
  fi

  assert_before "$sequence" "compose stop app worker n8n" "run-restore-failed"
  assert_not_contains "$sequence" "start-apps"
  assert_not_contains "$sequence" "compose start"
  assert_not_contains "$sequence" "compose up"
  assert_key_equals "$marker" target_version 1.0.0
  assert_key_equals "$marker" status pending
  if (
    DB_RESTORE_AUTHORIZATION="$marker"
    MIGRATION_PENDING="$TMP_DIR/restore-prod-fail.no-migration"
    assert_writer_start_authorized
  ) >"$guard_out" 2>&1; then
    test_fail "a failed production restore did not leave a persistent writer barrier"
  fi
  assert_contains "$guard_out" "nicht nachweislich erfolgreich abgeschlossen"
  pass "failed production restore persists a writer-start barrier"
}

test_isolated_restore_does_not_stop_production_writers() {
  local sequence="$TMP_DIR/restore-isolated.sequence"
  : >"$sequence"
  (
    record_step() { printf '%s\n' "$*" >>"$sequence"; }
    load_env() { :; }
    preflight_common() { :; }
    assert_production_env() { :; }
    start_infra() { record_step start-infra; }
    wait_postgres_healthy() { :; }
    wait_seaweedfs_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    compose() { record_step "compose $*"; }
    run_restore() { record_step "run-restore $*"; }
    cmd_restore --latest --target-url postgresql://example/restore
  ) >/dev/null 2>&1 || test_fail "isolated restore failed"

  assert_contains "$sequence" "run-restore --latest --target-url postgresql://example/restore"
  assert_not_contains "$sequence" "compose stop"
  pass "isolated restore leaves production writers running"
}

test_smoke_health_rejects_degraded() {
  local out="$TMP_DIR/smoke-degraded.out"
  if (
    curl() { printf '{"status":"degraded"}\n'; }
    sleep() { :; }
    compose() { :; }
    app_port() { printf '3000'; }
    smoke_health
  ) >"$out" 2>&1; then
    test_fail "smoke_health accepted degraded as a successful rollout"
  fi
  assert_contains "$out" "nur status=ok gilt als bereit"
  pass "health smoke rejects degraded dependencies"
}

test_deploy_readiness_rejects_missing_hostports() {
  local out="$TMP_DIR/readiness-no-ports.out"
  if (
    docker() { return 0; }
    deploy_readiness
  ) >"$out" 2>&1; then
    test_fail "deploy_readiness silently skipped missing host ports"
  fi
  assert_contains "$out" "Hostports nicht ermittelbar"
  pass "deploy readiness fails closed when host ports are unavailable"
}

test_backup_manifest_detects_tampering() {
  local root="$TMP_DIR/full-backup" keys="$TMP_DIR/manifest-keys" out="$TMP_DIR/manifest.out"
  mkdir -p "$root"
  printf 'dump-bytes' >"$root/full-backup.tar.age"
  node_host "$REPO_ROOT/scripts/backup/manifest.mjs" generate-key --out-dir "$keys" >/dev/null
  node_host "$REPO_ROOT/scripts/backup/manifest.mjs" create \
    --root "$root" --private-key "$keys/backup-manifest-private.pem" \
    --version 1.2.3 --commit 0123456789012345678901234567890123456789 >/dev/null
  node_host "$REPO_ROOT/scripts/backup/manifest.mjs" verify \
    --root "$root" --public-key "$keys/backup-manifest-public.pem" >"$out"
  assert_contains "$out" "Signatur und SHA-256-Inventar gueltig"
  printf 'tampered' >>"$root/full-backup.tar.age"
  if node_host "$REPO_ROOT/scripts/backup/manifest.mjs" verify \
    --root "$root" --public-key "$keys/backup-manifest-public.pem" >"$out" 2>&1; then
    test_fail "backup manifest accepted modified payload"
  fi
  assert_contains "$out" "VERAENDERT: full-backup.tar.age"
  pass "signed backup manifest detects payload tampering"
}

run_mock_update() (
  ROOT="$TMP_DIR/mock-update-root"
  mkdir -p "$ROOT"

  record_step() { printf '%s\n' "$*" >>"$OPS_SEQUENCE"; }
  require_cmd() { :; }
  prepare_env_interactive() { record_step prepare-env; }
  load_env() { record_step load-env; }
  preflight_common() { record_step preflight; }
  assert_production_env() { record_step assert-production; }
  require_release_version() { record_step require-version; }
  start_infra() { record_step start-infra; }
  wait_postgres_healthy() { record_step wait-postgres; }
  sync_postgres_roles_from_env() { record_step sync-roles; }
  run_backup() { record_step backup-old-checkout; return "${OPS_BACKUP_STATUS:-0}"; }
  git() { record_step "git $*"; }
  deployment_git_remote() { printf 'origin'; }
  prepare_release_contract() { record_step prepare-release-contract; }
  provide_images() { record_step provide-images; }
  run_migrations() { record_step migrate; }
  start_apps() { record_step start-apps; }
  smoke_health() { record_step smoke-health; }
  deploy_readiness() { record_step deploy-readiness; }
  save_state() { record_step save-state; }
  commit_release_contract() { record_step commit-release-contract; }
  image_tag() { printf 'test-version'; }

  cmd_update
)

test_update_backs_up_old_checkout_before_fetch() {
  local sequence="$TMP_DIR/update-order.log" out="$TMP_DIR/update-order.out"
  : >"$sequence"
  OPS_SEQUENCE="$sequence" run_mock_update >"$out" 2>&1 || test_fail "mock update failed"
  assert_before "$sequence" "backup-old-checkout" "git fetch origin"
  assert_before "$sequence" "backup-old-checkout" "git merge --ff-only origin/main"
  assert_before "$sequence" "git merge --ff-only origin/main" "provide-images"
  pass "update completes mandatory old-checkout backup before fetch and merge"
}

test_update_backup_failure_leaves_checkout_untouched() {
  local sequence="$TMP_DIR/update-backup-fail.log" out="$TMP_DIR/update-backup-fail.out"
  : >"$sequence"
  if OPS_SEQUENCE="$sequence" OPS_BACKUP_STATUS=23 run_mock_update >"$out" 2>&1; then
    test_fail "update continued despite failed mandatory backup"
  fi
  assert_contains "$sequence" "backup-old-checkout"
  assert_not_contains "$sequence" "git fetch"
  assert_not_contains "$sequence" "git merge"
  assert_not_contains "$sequence" "provide-images"
  assert_contains "$out" "Code und Arbeitsbaum bleiben unveraendert"
  pass "failed mandatory backup prevents every checkout change"
}

write_release_env() {
  local file="$1" version="$2" web_suffix="$3" worker_suffix="$4" commit="$5"
  cat >"$file" <<EOF
NODE_ENV=production
TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
TAXTRONIK_VERSION=$version
TAXTRONIK_WEB_DIGEST_SUFFIX=$web_suffix
TAXTRONIK_WORKER_DIGEST_SUFFIX=$worker_suffix
TAXTRONIK_RELEASE_COMMIT=$commit
TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED=false
EOF
}

write_release_state() {
  local file="$1"
  cat >"$file" <<EOF
previous=1.0.0
previous_web_digest_suffix=@sha256:$(printf '1%.0s' {1..64})
previous_worker_digest_suffix=@sha256:$(printf '2%.0s' {1..64})
previous_commit=$(printf 'a%.0s' {1..40})
current=2.0.0
current_web_digest_suffix=@sha256:$(printf '3%.0s' {1..64})
current_worker_digest_suffix=@sha256:$(printf '4%.0s' {1..64})
current_commit=$(printf 'b%.0s' {1..40})
current_rollback_requires_db_restore=false
EOF
}

test_release_contract_is_not_persisted_before_health() {
  local env_file="$TMP_DIR/release-stage.env" out="$TMP_DIR/release-stage.out"
  local old_web="@sha256:$(printf '7%.0s' {1..64})"
  local old_worker="@sha256:$(printf '8%.0s' {1..64})"
  local old_commit="$(printf 'c%.0s' {1..40})"
  write_release_env "$env_file" 2.0.0 "$old_web" "$old_worker" "$old_commit"

  if (
    ENVFILE="$env_file"
    TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
    TAXTRONIK_VERSION=2.0.0
    load_env() { :; }
    preflight_common() { :; }
    assert_production_env() { :; }
    require_release_version() { :; }
    images_from_registry() { return 0; }
    resolve_release_contract() {
      UPDATE_VERSION=2.0.0
      UPDATE_COMMIT_SHA="$(printf 'd%.0s' {1..40})"
      UPDATE_MIGRATIONS_REQUIRED=true
      UPDATE_MIN_PREVIOUS_VERSION=""
      UPDATE_WEB_IMAGE=registry.example/taxtronik/web:2.0.0
      UPDATE_WEB_DIGEST="sha256:$(printf '5%.0s' {1..64})"
      UPDATE_WORKER_IMAGE=registry.example/taxtronik/worker:2.0.0
      UPDATE_WORKER_DIGEST="sha256:$(printf '6%.0s' {1..64})"
    }
    verify_release_checkout() { :; }
    start_infra() { :; }
    wait_postgres_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    provide_images() { :; }
    backup_before_migrations() { :; }
    run_migrations() { :; }
    ensure_provisioned_interactive() { :; }
    start_apps() { :; }
    smoke_health() { return 1; }
    deploy_readiness() { test_fail "readiness must not run after failed health"; }
    save_state() { test_fail "state must not be saved after failed health"; }
    _deploy_core
  ) >"$out" 2>&1; then
    test_fail "deploy unexpectedly succeeded despite failed health"
  fi

  assert_key_equals "$env_file" TAXTRONIK_WEB_DIGEST_SUFFIX "$old_web"
  assert_key_equals "$env_file" TAXTRONIK_WORKER_DIGEST_SUFFIX "$old_worker"
  assert_key_equals "$env_file" TAXTRONIK_RELEASE_COMMIT "$old_commit"
  assert_key_equals "$env_file" TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED false
  pass "release contract is persisted only after successful health/readiness"
}

run_mock_registry_rollback() (
  local env_file="$1" state_file="$2" selected_file="$3" requested="${4:-}"
  ENVFILE="$env_file"
  STATE="$state_file"
  require_cmd() { :; }
  preflight_common() { :; }
  assert_production_env() { :; }
  images_from_registry() { return 0; }
  resolve_release_contract() { test_fail "state-backed rollback unexpectedly resolved the remote manifest"; }
  fetch_verified_release_tag() { :; }
  pull_release_images_direct() { :; }
  require_clean_release_checkout() { :; }
  start_apps() { printf '%s\n' "$TAXTRONIK_VERSION" >"$selected_file"; }
  smoke_health() { return 0; }
  deploy_readiness() { return 0; }
  save_state() { :; }
  git() { :; }
  cmd_rollback "$requested"
)

test_failed_update_recovers_state_current() {
  local env_file="$TMP_DIR/rollback-pending.env" state_file="$TMP_DIR/rollback-pending.state"
  local selected="$TMP_DIR/rollback-pending.selected"
  write_release_env "$env_file" 3.0.0 \
    "@sha256:$(printf '5%.0s' {1..64})" "@sha256:$(printf '6%.0s' {1..64})" \
    "$(printf 'd%.0s' {1..40})"
  write_release_state "$state_file"

  run_mock_registry_rollback "$env_file" "$state_file" "$selected" >/dev/null 2>&1 || \
    test_fail "failed-update recovery rollback failed"
  assert_file_equals "$selected" 2.0.0
  pass "failed update recovers the last-good state.current contract"
}

test_normal_rollback_uses_state_previous() {
  local env_file="$TMP_DIR/rollback-normal.env" state_file="$TMP_DIR/rollback-normal.state"
  local selected="$TMP_DIR/rollback-normal.selected"
  write_release_env "$env_file" 2.0.0 \
    "@sha256:$(printf '3%.0s' {1..64})" "@sha256:$(printf '4%.0s' {1..64})" \
    "$(printf 'b%.0s' {1..40})"
  write_release_state "$state_file"

  run_mock_registry_rollback "$env_file" "$state_file" "$selected" >/dev/null 2>&1 || \
    test_fail "normal rollback failed"
  assert_file_equals "$selected" 1.0.0
  pass "normal rollback selects state.previous"
}

test_rollback_blocks_migration_boundary_and_legacy_state() {
  local out_true="$TMP_DIR/rollback-migration-true.out"
  local out_unknown="$TMP_DIR/rollback-migration-unknown.out"
  if ( assert_rollback_database_compatible 1.0.0 2.0.0 1.0.0 true ) >"$out_true" 2>&1; then
    test_fail "rollback crossed a known migration boundary"
  fi
  assert_contains "$out_true" "DB-Schemas mit previous ist 'true'"

  if ( assert_rollback_database_compatible 1.0.0 2.0.0 1.0.0 unknown ) >"$out_unknown" 2>&1; then
    test_fail "rollback accepted a legacy/unknown compatibility state"
  fi
  assert_contains "$out_unknown" "DB-Schemas mit previous ist 'unknown'"
  pass "rollback blocks known and unknown migration boundaries"
}

test_pending_migration_blocks_failed_update_recovery() {
  local marker="$TMP_DIR/migration-pending-danger" out="$TMP_DIR/migration-pending-danger.out"
  cat >"$marker" <<EOF
source_version=2.0.0
source_commit=$(printf 'b%.0s' {1..40})
target_version=3.0.0
target_commit=$(printf 'd%.0s' {1..40})
requires_db_restore=true
EOF
  if (
    MIGRATION_PENDING="$marker"
    assert_rollback_database_compatible 2.0.0 2.0.0 1.0.0 false
  ) >"$out" 2>&1; then
    test_fail "failed-update recovery started old code after a pending migration"
  fi
  assert_contains "$out" "nicht finalisierter Migrationslauf"
  pass "pending migration blocks failed-update recovery"
}

test_pending_non_migration_allows_only_source_recovery() {
  local marker="$TMP_DIR/migration-pending-safe" out="$TMP_DIR/migration-pending-safe.out"
  cat >"$marker" <<EOF
source_version=2.0.0
source_commit=$(printf 'b%.0s' {1..40})
target_version=3.0.0
target_commit=$(printf 'd%.0s' {1..40})
requires_db_restore=false
EOF
  (
    MIGRATION_PENDING="$marker"
    assert_rollback_database_compatible 2.0.0 2.0.0 1.0.0 false
  ) || test_fail "safe pending activation did not allow its exact source recovery"
  if (
    MIGRATION_PENDING="$marker"
    assert_rollback_database_compatible 1.0.0 2.0.0 1.0.0 false
  ) >"$out" 2>&1; then
    test_fail "safe pending activation allowed an arbitrary older target"
  fi
  assert_contains "$out" "nur der vorgemerkte Quellstand '2.0.0'"
  pass "pending non-migration activation allows only exact source recovery"
}

test_state_persists_migration_rollback_requirement() {
  local state_file="$TMP_DIR/migration-state" marker="$TMP_DIR/migration-state.pending"
  write_release_state "$state_file"
  cat >"$marker" <<'EOF'
source_version=2.0.0
target_version=3.0.0
requires_db_restore=true
EOF
  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_WEB_DIGEST_SUFFIX="@sha256:$(printf '5%.0s' {1..64})"
    TAXTRONIK_WORKER_DIGEST_SUFFIX="@sha256:$(printf '6%.0s' {1..64})"
    TAXTRONIK_RELEASE_COMMIT="$(printf 'd%.0s' {1..40})"
    save_state
  )
  assert_key_equals "$state_file" current_rollback_requires_db_restore true
  pass "release state persists migration rollback requirement"
}

test_restored_rollback_blocks_unmigrated_reverse_path() {
  local state_file="$TMP_DIR/restored-reverse.state"
  local marker="$TMP_DIR/restored-reverse.authorization" out="$TMP_DIR/restored-reverse.out"
  write_release_state "$state_file"
  cat >"$marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF

  (
    STATE="$state_file"
    DB_RESTORE_AUTHORIZATION="$marker"
    TAXTRONIK_VERSION=1.0.0
    TAXTRONIK_WEB_DIGEST_SUFFIX="@sha256:$(printf '1%.0s' {1..64})"
    TAXTRONIK_WORKER_DIGEST_SUFFIX="@sha256:$(printf '2%.0s' {1..64})"
    TAXTRONIK_RELEASE_COMMIT="$(printf 'a%.0s' {1..40})"
    TAXTRONIK_ROLLBACK_REQUIRES_DB_RESTORE=false
    save_state
  )

  assert_key_equals "$state_file" current 1.0.0
  assert_key_equals "$state_file" previous 2.0.0
  assert_key_equals "$state_file" current_rollback_requires_db_restore unknown
  rm -f "$marker"
  if (
    STATE="$state_file"
    DB_RESTORE_AUTHORIZATION="$marker"
    MIGRATION_PENDING="$TMP_DIR/restored-reverse.no-migration"
    assert_rollback_database_compatible 2.0.0 1.0.0 2.0.0 unknown
  ) >"$out" 2>&1; then
    test_fail "restored schema allowed reverse activation without migrations"
  fi
  assert_contains "$out" "DB-Schemas mit previous ist 'unknown'"
  pass "database restore blocks an unmigrated reverse rollback"
}

test_database_restore_authorizes_only_declared_release() {
  local marker="$TMP_DIR/database-restored" out="$TMP_DIR/database-restored.out"
  cat >"$marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF
  (
    DB_RESTORE_AUTHORIZATION="$marker"
    assert_rollback_database_compatible 1.0.0 2.0.0 1.5.0 true
  ) || test_fail "matching restored release was not authorized"
  if (
    DB_RESTORE_AUTHORIZATION="$marker"
    assert_rollback_database_compatible 1.5.0 2.0.0 1.5.0 true
  ) >"$out" 2>&1; then
    test_fail "restore authorization was reused for a different release"
  fi
  assert_contains "$out" "ausschliesslich fuer Release 1.0.0 autorisiert"
  pass "database restore authorizes only its declared release"
}

test_migration_transition_preserves_strongest_requirement() {
  local state_file="$TMP_DIR/transition-monotonic.state"
  local marker="$TMP_DIR/transition-monotonic.pending"
  local source_commit target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  target_commit="$(printf 'd%.0s' {1..40})"
  write_release_state "$state_file"

  cat >"$marker" <<EOF
source_version=2.0.0
source_commit=$source_commit
target_version=3.0.0
target_commit=$target_commit
requires_db_restore=true
EOF
  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-monotonic.no-restore"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    pending_database_migration_requirement() { printf 'false'; }
    begin_migration_transition
  ) >/dev/null
  assert_key_equals "$marker" requires_db_restore true

  sed -i 's/requires_db_restore=true/requires_db_restore=unknown/' "$marker"
  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-monotonic.no-restore"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    pending_database_migration_requirement() { printf 'false'; }
    begin_migration_transition
  ) >/dev/null
  assert_key_equals "$marker" requires_db_restore unknown

  sed -i 's/requires_db_restore=unknown/requires_db_restore=false/' "$marker"
  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-monotonic.no-restore"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    pending_database_migration_requirement() { printf 'true'; }
    begin_migration_transition
  ) >/dev/null
  assert_key_equals "$marker" requires_db_restore true
  pass "migration retry preserves or strengthens the original restore barrier"
}

test_migration_transition_never_replaces_another_contract() {
  local state_file="$TMP_DIR/transition-conflict.state"
  local marker="$TMP_DIR/transition-conflict.pending" before="$TMP_DIR/transition-conflict.before"
  local out="$TMP_DIR/transition-conflict.out" source_commit old_target_commit new_target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"
  write_release_state "$state_file"
  cat >"$marker" <<EOF
source_version=2.0.0
source_commit=$source_commit
target_version=2.5.0
target_commit=$old_target_commit
requires_db_restore=unknown
EOF
  cp "$marker" "$before"
  if (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-conflict.no-restore"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_RELEASE_COMMIT="$new_target_commit"
    pending_database_migration_requirement() { printf 'false'; }
    begin_migration_transition
  ) >"$out" 2>&1; then
    test_fail "a pending migration contract was replaced by another transition"
  fi
  cmp -s "$marker" "$before" || test_fail "conflicting transition modified the original marker"
  assert_contains "$out" "anderen Release-Uebergang"
  pass "migration retry refuses to replace a different pending contract"
}

test_compose_writer_passthrough_is_blocked_by_recovery_markers() {
  local restore_marker="$TMP_DIR/compose-guard.restore" pending_marker="$TMP_DIR/compose-guard.pending"
  local missing_restore="$TMP_DIR/compose-guard.no-restore" missing_pending="$TMP_DIR/compose-guard.no-pending"
  local target_commit side out command kind
  target_commit="$(printf 'd%.0s' {1..40})"
  cat >"$restore_marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF
  cat >"$pending_marker" <<EOF
source_version=2.0.0
source_commit=$(printf 'b%.0s' {1..40})
target_version=3.0.0
target_commit=$target_commit
requires_db_restore=true
EOF

  for kind in restore pending; do
    for command in up restart; do
      side="$TMP_DIR/compose-guard-${kind}-${command}.side"
      out="$TMP_DIR/compose-guard-${kind}-${command}.out"
      if (
        if [[ "$kind" == "restore" ]]; then
          DB_RESTORE_AUTHORIZATION="$restore_marker"; MIGRATION_PENDING="$missing_pending"
        else
          DB_RESTORE_AUTHORIZATION="$missing_restore"; MIGRATION_PENDING="$pending_marker"
          TAXTRONIK_RELEASE_COMMIT="$target_commit"
        fi
        render_s3_config() { printf 'render\n' >>"$side"; }
        ensure_compose_image_pinning() { printf 'pinning\n' >>"$side"; }
        reconcile_n8n_encryption_key_from_volume() { printf 'reconcile\n' >>"$side"; }
        docker() { printf 'docker %s\n' "$*" >>"$side"; }
        compose "$command" -d
      ) >"$out" 2>&1; then
        test_fail "compose $command bypassed the $kind writer barrier"
      fi
      assert_not_exists_or_empty "$side"
      assert_contains "$out" "Writer-Start blockiert"
    done
  done
  pass "CLI compose up/restart cannot bypass restore or migration barriers"
}

test_internal_writer_activation_is_bound_to_exact_contract() {
  local pending_marker="$TMP_DIR/writer-activation.pending" restore_marker="$TMP_DIR/writer-activation.restore"
  local missing_restore="$TMP_DIR/writer-activation.no-restore" missing_pending="$TMP_DIR/writer-activation.no-pending"
  local source_commit target_commit side out
  source_commit="$(printf 'b%.0s' {1..40})"
  target_commit="$(printf 'd%.0s' {1..40})"
  cat >"$pending_marker" <<EOF
source_version=2.0.0
source_commit=$source_commit
target_version=3.0.0
target_commit=$target_commit
requires_db_restore=true
EOF
  side="$TMP_DIR/writer-activation.allowed.side"
  (
    MIGRATION_PENDING="$pending_marker"
    DB_RESTORE_AUTHORIZATION="$missing_restore"
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    run_backup_dir_init() { printf 'backup-dir-init\n' >>"$side"; }
    compose() { printf 'compose %s\n' "$*" >>"$side"; }
    start_apps_for_activation deploy 3.0.0
  ) >/dev/null
  assert_contains "$side" "backup-dir-init"
  assert_contains "$side" "compose up"

  side="$TMP_DIR/writer-activation-denied.side"
  out="$TMP_DIR/writer-activation-denied.out"
  if (
    MIGRATION_PENDING="$pending_marker"
    DB_RESTORE_AUTHORIZATION="$missing_restore"
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    run_backup_dir_init() { printf 'backup-dir-init\n' >>"$side"; }
    compose() { printf 'compose\n' >>"$side"; }
    start_apps_for_activation deploy 3.0.1
  ) >"$out" 2>&1; then
    test_fail "a mismatching deploy contract started writers"
  fi
  assert_not_exists_or_empty "$side"
  assert_contains "$out" "Nicht finalisierter Migrationsvertrag"

  cat >"$restore_marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF
  side="$TMP_DIR/writer-restore-allowed.side"
  (
    DB_RESTORE_AUTHORIZATION="$restore_marker"
    MIGRATION_PENDING="$missing_pending"
    run_backup_dir_init() { printf 'backup-dir-init\n' >>"$side"; }
    compose() { printf 'compose %s\n' "$*" >>"$side"; }
    start_apps_for_activation rollback 1.0.0
  ) >/dev/null
  assert_contains "$side" "compose up"

  side="$TMP_DIR/writer-restore-denied.side"
  if (
    DB_RESTORE_AUTHORIZATION="$restore_marker"
    MIGRATION_PENDING="$missing_pending"
    run_backup_dir_init() { printf 'backup-dir-init\n' >>"$side"; }
    compose() { printf 'compose\n' >>"$side"; }
    start_apps_for_activation deploy 1.0.0
  ) >"$out" 2>&1; then
    test_fail "a deploy activated a restored production database"
  fi
  assert_not_exists_or_empty "$side"
  assert_contains "$out" "nur mit './taxtronik rollback 1.0.0'"
  pass "internal writer activation is bound to the exact deploy or restored rollback contract"
}

test_full_backup_cannot_start_n8n_behind_restore_barrier() {
  local marker="$TMP_DIR/full-backup.restore" missing_pending="$TMP_DIR/full-backup.no-pending"
  local side="$TMP_DIR/full-backup-guard.side" out="$TMP_DIR/full-backup-guard.out"
  cat >"$marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF
  if (
    DB_RESTORE_AUTHORIZATION="$marker"
    MIGRATION_PENDING="$missing_pending"
    load_env() { :; }
    preflight_common() { :; }
    assert_production_env() { :; }
    require_cmd() { :; }
    start_infra() { :; }
    wait_postgres_healthy() { :; }
    wait_seaweedfs_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    render_s3_config() { printf 'render\n' >>"$side"; }
    ensure_compose_image_pinning() { printf 'pinning\n' >>"$side"; }
    reconcile_n8n_encryption_key_from_volume() { printf 'reconcile\n' >>"$side"; }
    docker() { printf 'docker %s\n' "$*" >>"$side"; }
    cmd_backup_full
  ) >"$out" 2>&1; then
    test_fail "backup-full started n8n behind a restore barrier"
  fi
  assert_not_exists_or_empty "$side"
  assert_contains "$out" "Writer-Start blockiert"
  pass "backup-full cannot start n8n behind a restore barrier"
}

test_restore_rollback_requires_explicit_matching_version() {
  local marker="$TMP_DIR/rollback-explicit.restore" missing_pending="$TMP_DIR/rollback-explicit.no-pending"
  local env_file="$TMP_DIR/rollback-explicit.env" state_file="$TMP_DIR/rollback-explicit.state"
  local selected="$TMP_DIR/rollback-explicit.selected" out="$TMP_DIR/rollback-explicit.out"
  cat >"$marker" <<'EOF'
target_version=1.0.0
status=ready
created_at=2026-07-14T00:00:00Z
EOF
  write_release_env "$env_file" 2.0.0 \
    "@sha256:$(printf '3%.0s' {1..64})" "@sha256:$(printf '4%.0s' {1..64})" \
    "$(printf 'b%.0s' {1..40})"
  write_release_state "$state_file"

  if DB_RESTORE_AUTHORIZATION="$marker" MIGRATION_PENDING="$missing_pending" \
    run_mock_registry_rollback "$env_file" "$state_file" "$selected" >"$out" 2>&1; then
    test_fail "restore rollback inferred its target without an explicit version"
  fi
  assert_not_exists_or_empty "$selected"
  assert_contains "$out" "Zielversion Pflicht"

  if DB_RESTORE_AUTHORIZATION="$marker" MIGRATION_PENDING="$missing_pending" \
    run_mock_registry_rollback "$env_file" "$state_file" "$selected" 1.5.0 >"$out" 2>&1; then
    test_fail "restore rollback accepted a mismatching explicit version"
  fi
  assert_not_exists_or_empty "$selected"
  assert_contains "$out" "autorisiert ist ausschliesslich '1.0.0'"

  DB_RESTORE_AUTHORIZATION="$marker" MIGRATION_PENDING="$missing_pending" \
    run_mock_registry_rollback "$env_file" "$state_file" "$selected" 1.0.0 >/dev/null 2>&1 || \
    test_fail "matching explicit restore rollback failed"
  assert_file_equals "$selected" 1.0.0
  [[ ! -e "$marker" ]] || test_fail "successful restored rollback did not consume its authorization"
  pass "restored database requires an explicit exactly matching rollback version"
}

test_inherited_internal_authorization_is_sanitized() {
  local out="$TMP_DIR/internal-env-sanitized.out"
  _TAXTRONIK_INTERNAL_WRITER_START_REASON=deploy \
  _TAXTRONIK_INTERNAL_WRITER_START_TARGET=3.0.0 \
  _TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED=1 \
    bash -c 'source "$1"; printf "%s|%s|%s\n" "${_TAXTRONIK_INTERNAL_WRITER_START_REASON:-unset}" "${_TAXTRONIK_INTERNAL_WRITER_START_TARGET:-unset}" "${_TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED:-unset}"' \
      _ "$REPO_ROOT/scripts/ops-lib.sh" >"$out"
  assert_file_equals "$out" "unset|unset|unset"
  pass "inherited internal authorization flags are sanitized"
}

test_identical_redeploy_preserves_previous_state() {
  local state_file="$TMP_DIR/redeploy.state"
  write_release_state "$state_file"
  (
    STATE="$state_file"
    TAXTRONIK_VERSION=2.0.0
    TAXTRONIK_WEB_DIGEST_SUFFIX="@sha256:$(printf '3%.0s' {1..64})"
    TAXTRONIK_WORKER_DIGEST_SUFFIX="@sha256:$(printf '4%.0s' {1..64})"
    TAXTRONIK_RELEASE_COMMIT="$(printf 'b%.0s' {1..40})"
    save_state
  )

  assert_key_equals "$state_file" previous 1.0.0
  assert_key_equals "$state_file" previous_web_digest_suffix \
    "@sha256:$(printf '1%.0s' {1..64})"
  assert_key_equals "$state_file" previous_worker_digest_suffix \
    "@sha256:$(printf '2%.0s' {1..64})"
  assert_key_equals "$state_file" previous_commit "$(printf 'a%.0s' {1..40})"
  pass "identical redeploy preserves the real previous release contract"
}

test_min_previous_without_state_fails_for_existing_installation() {
  local manifest="$TMP_DIR/min-previous-manifest.json" signature
  local out="$TMP_DIR/min-previous.out" missing_state="$TMP_DIR/no-release.state"
  signature="${manifest}.sig"
  printf '{}\n' >"$manifest"
  printf 'ed25519:test\n' >"$signature"

  if (
    STATE="$missing_state"
    ROOT="$REPO_ROOT"
    TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
    TAXTRONIK_VERSION=2.0.0
    UPDATE_PUBLIC_KEY=test-public-key
    UPDATE_MANIFEST_FILE="$manifest"
    UPDATE_MANIFEST_SIGNATURE_FILE="$signature"
    images_from_registry() { return 0; }
    _n8n_container_id() { printf 'existing-container-id\n'; }
    _app_container_id() { printf 'existing-container-id\n'; }
    existing_installation_detected() { return 0; }
    node() {
      cat <<EOF
UPDATE_VERSION=2.0.0
UPDATE_COMMIT_SHA=$(printf 'd%.0s' {1..40})
UPDATE_MIGRATIONS_REQUIRED=true
UPDATE_MIN_PREVIOUS_VERSION=1.5.0
UPDATE_WEB_IMAGE=registry.example/taxtronik/web:2.0.0
UPDATE_WEB_DIGEST=sha256:$(printf '5%.0s' {1..64})
UPDATE_WORKER_IMAGE=registry.example/taxtronik/worker:2.0.0
UPDATE_WORKER_DIGEST=sha256:$(printf '6%.0s' {1..64})
EOF
    }
    resolve_release_contract
  ) >"$out" 2>&1; then
    test_fail "minPreviousVersion was accepted for an existing installation without state"
  fi
  assert_contains "$out" "minPreviousVersion"
  assert_contains "$out" "fehlt bei bestehender Installation"
  pass "existing installation without state cannot bypass minPreviousVersion"
}

test_secret_files_are_mode_0600() {
  local env_file="$TMP_DIR/private.env"
  local generated="$TMP_DIR/s3.generated.json" umask_file="$TMP_DIR/umask-created"
  printf 'S3_ACCESS_KEY=test-access\nS3_SECRET_KEY=test-secret\n' >"$env_file"
  printf 'stale-secret\n' >"$generated"
  chmod 0644 "$env_file" "$generated"

  (
    ENVFILE="$env_file"
    S3_GENERATED="$generated"
    set_env AUTH_SECRET test-auth-secret
    render_s3_config
    : >"$umask_file"
  )

  [[ "$(file_mode "$env_file")" == "600" ]] || test_fail ".env mode is not 0600"
  [[ ! -e "$generated" ]] || test_fail "obsolete host-side S3 secret config was not removed"
  [[ "$(file_mode "$umask_file")" == "600" ]] || test_fail "operator umask does not create mode 0600"
  pass "operator secrets use mode 0600/umask 077 without host-side S3 copy"
}

test_doctor_accepts_prod_smtp
test_doctor_rejects_mailhog
test_doctor_rejects_loopback_mailhog_port
test_doctor_rejects_disabled_auth_host_trust
test_doctor_accepts_internal_risk_layer_without_fetch_allowlist
test_doctor_rejects_incomplete_risk_layer_pair
test_prune_build_cache_calls_docker_builder_prune
test_prune_build_cache_can_be_disabled
test_prune_build_cache_failure_is_non_blocking
test_restore_source_detection_uses_s3_for_bucket_sources
test_restore_source_detection_skips_s3_for_local_file
test_restore_validation_requires_explicit_target
test_restore_validation_rejects_unknown_and_conflicting_args
test_restore_list_does_not_change_service_state
test_production_restore_requires_exact_confirmation_before_side_effects
test_production_restore_stops_writers_and_leaves_them_stopped
test_failed_production_restore_also_leaves_writers_stopped
test_isolated_restore_does_not_stop_production_writers
test_smoke_health_rejects_degraded
test_deploy_readiness_rejects_missing_hostports
test_backup_manifest_detects_tampering
test_update_backs_up_old_checkout_before_fetch
test_update_backup_failure_leaves_checkout_untouched
test_release_contract_is_not_persisted_before_health
test_failed_update_recovers_state_current
test_normal_rollback_uses_state_previous
test_rollback_blocks_migration_boundary_and_legacy_state
test_pending_migration_blocks_failed_update_recovery
test_pending_non_migration_allows_only_source_recovery
test_state_persists_migration_rollback_requirement
test_restored_rollback_blocks_unmigrated_reverse_path
test_database_restore_authorizes_only_declared_release
test_migration_transition_preserves_strongest_requirement
test_migration_transition_never_replaces_another_contract
test_compose_writer_passthrough_is_blocked_by_recovery_markers
test_internal_writer_activation_is_bound_to_exact_contract
test_full_backup_cannot_start_n8n_behind_restore_barrier
test_restore_rollback_requires_explicit_matching_version
test_inherited_internal_authorization_is_sanitized
test_identical_redeploy_preserves_previous_state
test_min_previous_without_state_fails_for_existing_installation
test_secret_files_are_mode_0600

printf '\n%s ops-lib tests passed.\n' "$TESTS_RUN"
