#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../ops-lib.sh
source "$REPO_ROOT/scripts/ops-lib.sh"

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
SMTP_HOST=smtp.example.de
SMTP_PORT=587
SMTP_FROM=TaxTronik <noreply@example.de>
EOF
}

run_doctor_with_env() {
  local env_file="$1" output="$2"
  (
    unset AUTH_SECRET N8N_HMAC_SECRET N8N_ENCRYPTION_KEY POSTGRES_PASSWORD
    unset TAXTRONIK_APP_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY N8N_DB_PASSWORD
    unset DATABASE_URL DATABASE_APP_URL NODE_ENV TAXTRONIK_VERSION NEXTAUTH_URL
    unset NEXTAUTH_TRUST_HOST RISK_LAYER_URL RISK_LAYER_TOKEN SMTP_HOST SMTP_PORT
    unset SMTP_FROM PORTAL_PUBLIC_URL STAFF_COOKIE_DOMAIN PORTAL_COOKIE_DOMAIN
    ENVFILE="$env_file"
    doctor
  ) >"$output" 2>&1
}

test_doctor_accepts_prod_smtp() {
  local env_file="$TMP_DIR/prod.env" out="$TMP_DIR/doctor-ok.out"
  write_prod_env "$env_file"
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor rejected a valid prod SMTP config"
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

test_doctor_accepts_prod_smtp
test_doctor_rejects_mailhog
test_doctor_rejects_loopback_mailhog_port
test_doctor_accepts_internal_risk_layer_without_fetch_allowlist
test_doctor_rejects_incomplete_risk_layer_pair
test_prune_build_cache_calls_docker_builder_prune
test_prune_build_cache_can_be_disabled
test_prune_build_cache_failure_is_non_blocking

printf '\n%s ops-lib tests passed.\n' "$TESTS_RUN"
