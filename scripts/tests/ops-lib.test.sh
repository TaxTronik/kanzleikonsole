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
  grep -Fq -- "$needle" "$file" || {
    printf '%s\n' "--- $file ---" >&2
    sed -n '1,220p' "$file" >&2
    test_fail "expected output to contain: $needle"
  }
}

assert_not_exists_or_empty() {
  local file="$1"
  [[ ! -e "$file" || ! -s "$file" ]] || {
    printf '%s\n' "--- $file ---" >&2
    cat "$file" >&2
    test_fail "expected file to be absent or empty: $file"
  }
}

assert_not_contains() {
  local file="$1" needle="$2"
  if [[ -f "$file" ]] && grep -Fq -- "$needle" "$file"; then
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
TAXTRONIK_DEPLOY_CHANNEL=source
TAXTRONIK_IMAGE_PREFIX=taxtronik
TAXTRONIK_VERSION=source-deadbeef1234
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
PORTAL_PUBLIC_URL=https://mandanten.example.de
N8N_HOST=n8n.example.de
N8N_WEBHOOK_URL=https://n8n.example.de/
N8N_PROXY_HOPS=1
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
    unset DATABASE_URL DATABASE_APP_URL NODE_ENV TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX TAXTRONIK_VERSION NEXTAUTH_URL
    unset NEXTAUTH_TRUST_HOST TRUST_PROXY_REQUIRED SIGNAL_DEPLOYMENT SIGNAL_DEPLOY_CHANNEL SIGNAL_IMAGE
    unset SIGNAL_GIT_URL SIGNAL_GIT_REF SIGNAL_GIT_DIR SIGNAL_BUILD_MEMORY_LIMIT SIGNAL_BUILD_MEMORY_RESERVE SIGNAL_BUILD_CPUS
    unset DEPLOYMENT_METHOD TRAEFIK_ACME_EMAIL N8N_HOST N8N_WEBHOOK_URL N8N_PROXY_HOPS
    unset RISK_LAYER_URL RISK_LAYER_TOKEN RISK_LAYER_OPERATOR_TOKEN RISK_LAYER_FESTWISSEN_DIR RISK_LAYER_EMB_DEVICE SMTP_HOST SMTP_PORT
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

test_doctor_accepts_complete_traefik_contract() {
  local env_file="$TMP_DIR/traefik-doctor.env" out="$TMP_DIR/traefik-doctor.out"
  write_prod_env "$env_file"
  {
    printf 'DEPLOYMENT_METHOD=traefik\n'
    printf 'PORTAL_PUBLIC_URL=https://portal.example.de\n'
    printf 'STAFF_COOKIE_DOMAIN=kanzlei.example.de\n'
    printf 'PORTAL_COOKIE_DOMAIN=portal.example.de\n'
    printf 'TRAEFIK_ACME_EMAIL=admin@example.de\n'
    printf 'N8N_HOST=n8n.example.de\n'
    printf 'N8N_WEBHOOK_URL=https://n8n.example.de/\n'
    printf 'N8N_PROXY_HOPS=1\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected a complete Traefik contract"
  }
  assert_contains "$out" "traefik (verwaltetes HTTPS)"
  assert_contains "$out" "OK       TRAEFIK_ACME_EMAIL"
  pass "doctor accepts complete managed Traefik contract"
}

test_doctor_rejects_unsafe_traefik_proxy_trust() {
  local env_file="$TMP_DIR/traefik-trust.env" out="$TMP_DIR/traefik-trust.out"
  write_prod_env "$env_file"
  {
    printf 'DEPLOYMENT_METHOD=traefik\n'
    printf 'PORTAL_PUBLIC_URL=https://portal.example.de\n'
    printf 'STAFF_COOKIE_DOMAIN=kanzlei.example.de\n'
    printf 'PORTAL_COOKIE_DOMAIN=portal.example.de\n'
    printf 'TRAEFIK_ACME_EMAIL=admin@example.de\n'
    printf 'N8N_HOST=n8n.example.de\n'
    printf 'N8N_WEBHOOK_URL=https://n8n.example.de/\n'
    printf 'N8N_PROXY_HOPS=1\n'
  } >>"$env_file"
  set_env_file_value "$env_file" TRUST_PROXY_REQUIRED false
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted Traefik without required proxy trust contract"
  fi
  assert_contains "$out" "Traefik-Pfad braucht exakt true"
  pass "doctor rejects Traefik without explicit proxy trust"
}

test_doctor_rejects_n8n_on_an_application_domain() {
  local env_file="$TMP_DIR/n8n-domain.env" out="$TMP_DIR/n8n-domain.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" N8N_HOST kanzlei.example.de
  set_env_file_value "$env_file" N8N_WEBHOOK_URL https://kanzlei.example.de/
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted n8n on the Kanzlei application domain"
  fi
  assert_contains "$out" "eigene HTTPS-Domain"
  pass "doctor requires a dedicated public n8n domain"
}

test_initial_setup_confirmation_and_atomic_plan_application() {
  local plan_root="$TMP_DIR/setup-plan" env_file="$TMP_DIR/setup-plan.env"
  mkdir -p "$plan_root"
  : >"$plan_root/.env.example"

  if confirm_initial_setup_plan "LEERE MASCHINE INSTALLIEREN" <<<"ja" >/dev/null; then
    test_fail "weak one-click confirmation was accepted"
  fi
  confirm_initial_setup_plan "LEERE MASCHINE INSTALLIEREN" \
    <<<"LEERE MASCHINE INSTALLIEREN" >/dev/null || test_fail "exact setup confirmation was rejected"
  [[ ! -e "$env_file" ]] || test_fail "confirmation unexpectedly wrote configuration"

  (
    ROOT="$plan_root"
    ENVFILE="$env_file"
    INSTALL_PENDING="$plan_root/install.pending"
    _SETUP_METHOD="traefik"
    _SETUP_DEPLOY_CHANNEL="release"
    _SETUP_IMAGE_PREFIX="registry.example/taxtronik"
    _SETUP_RELEASE_VERSION="1.2.3"
    _SETUP_STAFF_HOST="staff.example.de"
    _SETUP_PORTAL_HOST="portal.example.de"
    _SETUP_N8N_HOST="n8n.example.de"
    _SETUP_ACME_EMAIL="admin@example.de"
    _SETUP_SMTP_HOST="smtp.example.de"
    _SETUP_SMTP_PORT="587"
    _SETUP_SMTP_FROM="TaxTronik <noreply@example.de>"
    _SETUP_SMTP_USER="smtp-user"
    _SETUP_SMTP_PASSWORD='pa\ss&word|safe'
    _SETUP_SIGNAL_MODE="disabled"
    _SETUP_SIGNAL_CHANNEL=""
    _SETUP_SIGNAL_IMAGE=""
    _SETUP_SIGNAL_GIT_URL=""
    _SETUP_SIGNAL_GIT_REF=""
    _SETUP_SIGNAL_GIT_DIR=""
    _SETUP_SIGNAL_URL=""
    _SETUP_SIGNAL_TOKEN=""
    _SETUP_SIGNAL_OPERATOR_TOKEN=""
    _SETUP_TENANT_NAME="Testkanzlei"
    _SETUP_ADMIN_EMAIL="admin@example.de"
    apply_initial_setup_plan
  )
  assert_key_equals "$env_file" DEPLOYMENT_METHOD traefik
  assert_key_equals "$env_file" TAXTRONIK_DEPLOY_CHANNEL release
  assert_key_equals "$env_file" TAXTRONIK_IMAGE_PREFIX registry.example/taxtronik
  assert_key_equals "$env_file" TAXTRONIK_VERSION 1.2.3
  assert_key_equals "$env_file" NEXTAUTH_URL https://staff.example.de
  assert_key_equals "$env_file" PORTAL_PUBLIC_URL https://portal.example.de
  assert_key_equals "$env_file" N8N_HOST n8n.example.de
  assert_key_equals "$env_file" N8N_WEBHOOK_URL https://n8n.example.de/
  assert_key_equals "$env_file" N8N_PROXY_HOPS 1
  assert_key_equals "$env_file" SIGNAL_DEPLOY_CHANNEL ""
  assert_key_equals "$env_file" TRUST_PROXY_REQUIRED true
  assert_key_equals "$env_file" SMTP_PASSWORD 'pa\ss&word|safe'
  assert_key_equals "$env_file" TENANT_NAME Testkanzlei
  assert_key_equals "$env_file" ADMIN_EMAIL admin@example.de
  [[ -f "$plan_root/install.pending" ]] || test_fail "confirmed one-click setup did not persist its resume marker"
  assert_key_equals "$plan_root/install.pending" method traefik
  [[ "$(file_mode "$env_file")" == "600" ]] || test_fail "planned .env mode is not 0600"
  pass "initial setup applies nothing before exact confirmation and preserves values safely"
}

test_deploy_provisions_managed_n8n_in_acp() {
  local out="$TMP_DIR/n8n-acp-provision.out"
  (
    ROOT="$TMP_DIR"
    N8N_HOST=n8n.example.de
    generate_prisma_client_for_host_tools() { printf 'prisma-generated\n'; }
    pnpm() { printf 'pnpm %s\n' "$*"; }
    ensure_managed_n8n_connection
  ) >"$out"
  assert_contains "$out" "prisma-generated"
  assert_contains "$out" "pnpm --filter @taxtronik/db provision:n8n"

  : >"$out"
  (
    ROOT="$TMP_DIR"
    N8N_HOST=""
    generate_prisma_client_for_host_tools() { test_fail "Prisma generation ran without n8n"; }
    pnpm() { test_fail "n8n provisioning ran without n8n"; }
    ensure_managed_n8n_connection
  ) >"$out"
  [[ ! -s "$out" ]] || test_fail "disabled n8n provisioning produced unexpected output"
  pass "deploy provisions managed n8n ACP defaults only when n8n is configured"
}

test_one_click_blank_host_guard_rejects_existing_containers() {
  local out="$TMP_DIR/blank-host-guard.out"
  if (
    STATE="$TMP_DIR/no-state"
    MIGRATION_PENDING="$TMP_DIR/no-migration"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/no-restore"
    uname() { printf 'Linux\n'; }
    ss() { :; }
    getent() { :; }
    docker() { printf 'existing-container-id\n'; }
    assert_blank_host_for_traefik
  ) >"$out" 2>&1; then
    test_fail "one-click blank-host guard accepted existing Docker containers"
  fi
  assert_contains "$out" "komplett leere Maschine"
  pass "one-click path refuses non-empty Docker hosts"
}

test_one_click_blank_host_guard_rejects_unreachable_docker() {
  local out="$TMP_DIR/blank-host-docker.out"
  if (
    STATE="$TMP_DIR/no-state"
    MIGRATION_PENDING="$TMP_DIR/no-migration"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/no-restore"
    uname() { printf 'Linux\n'; }
    ss() { :; }
    getent() { :; }
    docker() { return 1; }
    assert_blank_host_for_traefik
  ) >"$out" 2>&1; then
    test_fail "one-click blank-host guard accepted an unreachable Docker daemon"
  fi
  assert_contains "$out" "Daemon nicht erreichbar"
  pass "one-click path fails closed when Docker emptiness cannot be proven"
}

test_one_click_blank_host_allows_missing_docker_for_deferred_install() {
  local docker_root="$TMP_DIR/empty-docker-root"
  mkdir -p "$docker_root"
  (
    STATE="$TMP_DIR/no-state"
    MIGRATION_PENDING="$TMP_DIR/no-migration"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/no-restore"
    TAXTRONIK_DOCKER_DATA_ROOT="$docker_root"
    uname() { printf 'Linux\n'; }
    docker_cli_available() { return 1; }
    ss() { :; }
    assert_blank_host_for_traefik
  ) || test_fail "blank one-click host without Docker was rejected before confirmed installation"
  pass "one-click defers missing Docker installation until after confirmation"
}

test_source_channel_derives_version_from_checkout_without_semver() {
  local expected actual
  expected="source-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  actual="$({
    ROOT="$REPO_ROOT"
    source_version_for_checkout
  })"
  [[ "$actual" == "$expected" ]] || test_fail "source version was not derived from HEAD"

  (
    ROOT="$REPO_ROOT"
    TAXTRONIK_DEPLOY_CHANNEL=source
    TAXTRONIK_IMAGE_PREFIX=taxtronik
    prepare_source_version_for_checkout
    require_release_version
    [[ "$TAXTRONIK_VERSION" == "$expected" ]]
  ) || test_fail "source channel unexpectedly required a SemVer"
  pass "source channel uses an automatic commit identity instead of asking for SemVer"
}

test_deployment_channel_is_explicit_with_legacy_prefix_fallback() {
  (
    TAXTRONIK_DEPLOY_CHANNEL=source
    TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
    ! images_from_registry
  ) || test_fail "explicit source channel was overridden by the image prefix"
  (
    TAXTRONIK_DEPLOY_CHANNEL=release
    TAXTRONIK_IMAGE_PREFIX=taxtronik
    images_from_registry
  ) || test_fail "explicit release channel was overridden by the image prefix"
  pass "deployment channel is explicit instead of being hidden in an image-prefix heuristic"
}

test_cli_presents_deploy_as_primary_path() {
  local cli="$REPO_ROOT/taxtronik" source="$REPO_ROOT/scripts/ops-lib.sh" help="$TMP_DIR/cli-help.out"
  bash "$cli" >"$help"
  assert_before "$help" "./taxtronik deploy" "./taxtronik bootstrap"
  assert_contains "$help" "./taxtronik config"
  assert_contains "$source" "Aktueller Git-Stand"
  assert_not_contains "$source" "Freigegebene TaxTronik-Version"
  assert_not_contains "$source" "Basisdomain"
  assert_not_contains "$source" "Domain-Stamm"
  assert_not_contains "$source" "Oeffentliche Server-IP"
  assert_contains "$source" "Kanzlei-/Mitarbeiterportal (vollstaendige Domain"
  assert_contains "$source" "Mandantenportal (vollstaendige Domain"
  assert_contains "$source" "n8n-Administration (vollstaendige Domain"
  pass "CLI leads with deploy and limits the SemVer prompt to an explicit release choice"
}

test_bootstrap_installs_one_click_requirements_after_configuration() {
  local steps="$TMP_DIR/bootstrap-host-requirements.steps"
  : >"$steps"
  (
    deployment_method() { printf 'traefik'; }
    assert_blank_host_for_traefik() { printf 'blank-check\n' >>"$steps"; }
    install_one_click_host_requirements() { printf 'host-install\n' >>"$steps"; }
    ensure_bootstrap_host_requirements
  )
  assert_file_equals "$steps" $'blank-check\nhost-install'

  : >"$steps"
  (
    configure_initial_deployment_interactive() { printf 'configure\n' >>"$steps"; }
    ensure_bootstrap_host_requirements() { printf 'host-requirements\n' >>"$steps"; }
    prepare_env_interactive() { printf 'env\n' >>"$steps"; }
    _deploy_core() { printf 'deploy\n' >>"$steps"; }
    image_tag() { printf '1.2.3'; }
    cmd_deploy
  ) >/dev/null
  assert_before "$steps" "configure" "host-requirements"
  assert_before "$steps" "host-requirements" "env"
  assert_before "$steps" "env" "deploy"
  local alias_out="$TMP_DIR/bootstrap-alias.out"
  (
    cmd_deploy() { printf 'delegated\n'; }
    cmd_bootstrap
  ) >"$alias_out" 2>&1
  assert_contains "$alias_out" "Kompatibilitaetsalias"
  assert_contains "$alias_out" "delegated"
  pass "deploy is the complete primary path and bootstrap only delegates as a legacy alias"
}

test_existing_one_click_deploy_does_not_reapply_blank_host_gate() {
  local state_file="$TMP_DIR/existing-one-click.state"
  : >"$state_file"
  (
    STATE="$state_file"
    deployment_method() { printf 'traefik'; }
    require_cmd() { :; }
    node_version_supported() { return 0; }
    docker() { return 0; }
    assert_blank_host_for_traefik() { return 91; }
    install_one_click_host_requirements() { return 92; }
    ensure_bootstrap_host_requirements
  ) || test_fail "existing one-click deployment was treated as a blank-host installation"
  pass "existing one-click deployments reuse verified prerequisites without rerunning the blank-host installer"
}

test_interrupted_one_click_deploy_resumes_only_owned_containers() {
  local env_file="$TMP_DIR/interrupted-one-click.env" marker="$TMP_DIR/interrupted-one-click.pending"
  local steps="$TMP_DIR/interrupted-one-click.steps"
  printf 'DEPLOYMENT_METHOD=traefik\n' >"$env_file"
  : >"$steps"
  (
    ENVFILE="$env_file"
    INSTALL_PENDING="$marker"
    STATE="$TMP_DIR/no-completed-state"
    MIGRATION_PENDING="$TMP_DIR/no-migration-state"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/no-restore-state"
    deployment_method() { printf 'traefik'; }
    docker_cli_available() { return 0; }
    _compose_project_name() { printf 'compose'; }
    one_click_public_ports_in_use() { return 1; }
    docker() {
      if [[ "$1 ${2:-}" == "ps -aq" ]]; then
        printf 'postgres-id\nredis-id\n'
      elif [[ "$*" == *'{{.Name}}'* && "${!#}" == "postgres-id" ]]; then
        printf '/taxtronik-postgres\n'
      elif [[ "$*" == *'{{.Name}}'* && "${!#}" == "redis-id" ]]; then
        printf '/taxtronik-redis\n'
      elif [[ "$*" == *'com.docker.compose.project'* ]]; then
        printf 'compose\n'
      else
        return 1
      fi
    }
    assert_blank_host_for_traefik() { test_fail "resume path reran the blank-host guard"; }
    install_one_click_host_requirements() { printf 'host-ready\n' >>"$steps"; }
    ensure_bootstrap_host_requirements
    printf 'source_version=source-old\ntarget_version=source-new\n' >"$MIGRATION_PENDING"
    ensure_bootstrap_host_requirements
  )
  assert_file_equals "$steps" $'host-ready\nhost-ready'
  assert_key_equals "$marker" method traefik
  pass "interrupted one-click deploy resumes owned containers before and during migration recovery"
}

test_interrupted_one_click_deploy_still_rejects_foreign_containers() {
  local env_file="$TMP_DIR/interrupted-foreign.env" out="$TMP_DIR/interrupted-foreign.out"
  printf 'DEPLOYMENT_METHOD=traefik\n' >"$env_file"
  if (
    ENVFILE="$env_file"
    INSTALL_PENDING="$TMP_DIR/interrupted-foreign.pending"
    STATE="$TMP_DIR/interrupted-foreign.no-completed-state"
    MIGRATION_PENDING="$TMP_DIR/interrupted-foreign.no-migration-state"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/interrupted-foreign.no-restore-state"
    deployment_method() { printf 'traefik'; }
    docker_cli_available() { return 0; }
    one_click_public_ports_in_use() { return 1; }
    _compose_project_name() { printf 'compose'; }
    docker() {
      if [[ "$1 ${2:-}" == "ps -aq" ]]; then printf 'foreign-id\n'
      elif [[ "$*" == *'{{.Name}}'* ]]; then printf '/customer-container\n'
      else return 1
      fi
    }
    install_one_click_host_requirements() { test_fail "foreign-container path changed the host"; }
    ensure_bootstrap_host_requirements
  ) >"$out" 2>&1; then
    test_fail "interrupted one-click path accepted a foreign container"
  fi
  assert_contains "$out" "Docker enthaelt bereits Container"
  pass "interrupted one-click deploy keeps foreign containers fail-closed"
}

test_one_click_runtime_install_contract_is_pinned_and_official() {
  local source="$REPO_ROOT/scripts/ops-lib.sh"
  [[ "$HOST_NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || test_fail "managed Node version is not pinned to Node 24"
  [[ "$HOST_NODE_LINUX_X64_SHA256" =~ ^[0-9a-f]{64}$ ]] || test_fail "Node x64 SHA-256 is not pinned"
  [[ "$HOST_NODE_LINUX_ARM64_SHA256" =~ ^[0-9a-f]{64}$ ]] || test_fail "Node arm64 SHA-256 is not pinned"
  [[ "$HOST_PNPM_VERSION" == "11.20.0" ]] || test_fail "pnpm host version drifted from packageManager"
  assert_contains "$source" 'https://download.docker.com/linux/${os_id}/gpg'
  assert_contains "$source" 'https://nodejs.org/download/release/v${HOST_NODE_VERSION}/node-v${HOST_NODE_VERSION}-linux-${platform}.tar.xz'
  assert_not_contains "$source" 'curl | sh'
  pass "one-click installs only pinned Node/pnpm and the official Docker repository"
}

test_one_click_replaces_incomplete_docker_only_after_blank_host_gate() {
  local steps="$TMP_DIR/docker-toolchain.steps"
  : >"$steps"
  (
    deployment_method() { printf 'traefik'; }
    assert_blank_host_for_traefik() { printf 'blank-check\n' >>"$steps"; }
    install_one_click_base_packages() { printf 'base-packages\n' >>"$steps"; }
    install_one_click_node() { printf 'node\n' >>"$steps"; }
    install_one_click_pnpm() { printf 'pnpm\n' >>"$steps"; }
    require_root_for_one_click() { :; }
    require_cmd() { :; }
    configure_official_docker_apt_repository() { printf 'docker-repository\n' >>"$steps"; }
    remove_conflicting_docker_packages_on_blank_host() { printf 'replace-incomplete-docker\n' >>"$steps"; }
    start_docker_daemon() { printf 'start-docker\n' >>"$steps"; }
    apt-get() { printf 'apt %s\n' "$*" >>"$steps"; }
    local ready_calls=0
    docker_one_click_toolchain_ready() {
      ready_calls=$((ready_calls + 1))
      (( ready_calls >= 2 ))
    }
    ensure_bootstrap_host_requirements
  )
  assert_before "$steps" "blank-check" "docker-repository"
  assert_before "$steps" "docker-repository" "replace-incomplete-docker"
  assert_before "$steps" "replace-incomplete-docker" "start-docker"
  assert_contains "$steps" "apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
  pass "one-click replaces incomplete Docker only behind the blank-host confirmation gate"
}

test_traefik_dynamic_route_and_compose_contract_are_socketless() {
  local env_file="$TMP_DIR/traefik-render.env" dynamic="$TMP_DIR/traefik-dynamic.yml"
  {
    printf 'DEPLOYMENT_METHOD=traefik\n'
    printf 'NEXTAUTH_URL=https://staff.example.de\n'
    printf 'PORTAL_PUBLIC_URL=https://portal.example.de\n'
    printf 'N8N_HOST=n8n.example.de\n'
    printf 'TRAEFIK_ACME_EMAIL=admin@example.de\n'
  } >"$env_file"
  (
    ENVFILE="$env_file"
    TRAEFIK_DYNAMIC="$dynamic"
    unset DEPLOYMENT_METHOD NEXTAUTH_URL PORTAL_PUBLIC_URL N8N_HOST TRAEFIK_ACME_EMAIL
    render_traefik_dynamic_config
  )
  assert_contains "$dynamic" 'rule: "Host(`staff.example.de`)"'
  assert_contains "$dynamic" 'rule: "Host(`portal.example.de`)"'
  assert_contains "$dynamic" 'rule: "Host(`n8n.example.de`)"'
  assert_contains "$dynamic" 'url: "http://app:3000"'
  assert_contains "$dynamic" 'url: "http://n8n:5678"'
  [[ "$(file_mode "$dynamic")" == "600" ]] || test_fail "Traefik dynamic config mode is not 0600"

  local bad_env="$TMP_DIR/traefik-shared-n8n.env" bad_out="$TMP_DIR/traefik-shared-n8n.out"
  cp "$env_file" "$bad_env"
  set_env_file_value "$bad_env" N8N_HOST portal.example.de
  if (
    ENVFILE="$bad_env"
    TRAEFIK_DYNAMIC="$TMP_DIR/traefik-shared-n8n.yml"
    unset DEPLOYMENT_METHOD NEXTAUTH_URL PORTAL_PUBLIC_URL N8N_HOST TRAEFIK_ACME_EMAIL
    render_traefik_dynamic_config
  ) >"$bad_out" 2>&1; then
    test_fail "Traefik accepted n8n on an application domain"
  fi
  assert_contains "$bad_out" "drei getrennte Domains"

  local overlay="$REPO_ROOT/infra/compose/docker-compose.traefik.yml"
  assert_contains "$overlay" "traefik:v3.7.9@sha256:"
  assert_contains "$overlay" "--providers.file.filename=/etc/traefik/dynamic.yml"
  assert_contains "$overlay" "--providers.file.watch=true"
  assert_contains "$overlay" "'80:80'"
  assert_contains "$overlay" "'443:443'"
  assert_contains "$overlay" "max-size: '10m'"
  assert_contains "$overlay" "max-file: '5'"
  assert_not_contains "$overlay" "docker.sock"
  assert_not_contains "$overlay" "providers.docker"
  pass "managed Traefik uses pinned socketless file-provider contract"
}

test_traefik_lifecycle_is_part_of_activation() {
  local calls="$TMP_DIR/traefik-lifecycle.calls"
  : >"$calls"
  (
    deployment_method() { printf 'traefik'; }
    assert_writer_start_authorized() { :; }
    run_backup_dir_init() { :; }
    compose() { printf 'compose %s\n' "$*" >>"$calls"; }
    start_apps
    provide_traefik_for_deploy
  ) >/dev/null
  assert_contains "$calls" "compose up -d --force-recreate --no-deps app worker n8n traefik"
  assert_contains "$calls" "compose pull traefik"
  pass "managed Traefik is pulled and activated with the application"
}

test_full_backup_snapshots_managed_traefik_acme_volume() {
  local calls="$TMP_DIR/traefik-backup.calls"
  : >"$calls"
  (
    deployment_method() { printf 'traefik'; }
    container_named_volume() {
      case "$2" in
        /data) [[ "$1" == "taxtronik-seaweedfs" ]] && printf 'seaweed-volume' || printf 'redis-volume' ;;
        /home/node/.n8n) printf 'n8n-volume' ;;
        /letsencrypt) printf 'traefik-acme-volume' ;;
      esac
    }
    compose() { printf 'compose %s\n' "$*" >>"$calls"; }
    snapshot_named_volume() { printf 'snapshot %s %s\n' "$1" "$3" >>"$calls"; }
    restart_backup_infra() { printf 'restart infra\n' >>"$calls"; }
    run_cold_volume_snapshots "$TMP_DIR/traefik-backup"
  )
  assert_contains "$calls" "compose --infra stop seaweedfs redis"
  assert_contains "$calls" "compose stop traefik"
  assert_contains "$calls" "snapshot traefik-acme-volume traefik-acme.tar.gz"
  assert_contains "$calls" "restart infra"
  pass "full backup includes managed Traefik ACME state"
}

test_doctor_accepts_internal_risk_layer_without_fetch_allowlist() {
  local env_file="$TMP_DIR/risk.env" out="$TMP_DIR/doctor-risk.out"
  write_prod_env "$env_file"
  {
    printf 'SIGNAL_DEPLOYMENT=external\n'
    printf 'RISK_LAYER_URL=http://10.10.0.42:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=operator-token-with-at-least-thirty-two-chars\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor rejected trusted internal Risk-Layer URL"
  assert_contains "$out" "OK       RISK_LAYER"
  assert_contains "$out" "OK       RISK_LAYER_OPERATOR_TOKEN"
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

test_doctor_warns_for_missing_risk_layer_operator_token_without_failing() {
  local env_file="$TMP_DIR/risk-missing-operator.env" out="$TMP_DIR/doctor-risk-operator.out"
  local release_dir="$TMP_DIR/signal-release-read-only"
  mkdir -p "$release_dir/catalog" "$release_dir/corpus"
  : >"$release_dir/catalog/begriffe.yaml"
  : >"$release_dir/corpus/graph.sqlite"
  write_prod_env "$env_file"
  {
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_FESTWISSEN_DIR=%s\n' "$release_dir"
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor hard-failed a legacy Risk-Layer config"
  assert_contains "$out" "RISK_LAYER_OPERATOR_TOKEN"
  assert_contains "$out" "Embedding-Steuerung bleibt read-only"
  pass "doctor warns for a missing Risk-Layer operator token without hard failure"
}

test_doctor_accepts_self_contained_managed_signal() {
  local env_file="$TMP_DIR/signal-managed.env" out="$TMP_DIR/doctor-signal-managed.out"
  write_prod_env "$env_file"
  {
    printf 'SIGNAL_DEPLOYMENT=managed\n'
    printf 'SIGNAL_DEPLOY_CHANNEL=image\n'
    printf 'SIGNAL_IMAGE=registry.example/taxtronik/signal:v1.2.3\n'
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=operator-token-with-at-least-thirty-two-chars\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor rejected a self-contained managed Signal release"
  assert_contains "$out" "OK       SIGNAL_IMAGE"
  assert_not_contains "$out" "RISK_LAYER_FESTWISSEN_DIR"
  pass "doctor accepts managed Signal without a host release mount"
}

test_doctor_rejects_managed_signal_latest_image() {
  local env_file="$TMP_DIR/signal-latest.env" out="$TMP_DIR/doctor-signal-latest.out"
  write_prod_env "$env_file"
  {
    printf 'SIGNAL_DEPLOYMENT=managed\n'
    printf 'SIGNAL_DEPLOY_CHANNEL=image\n'
    printf 'SIGNAL_IMAGE=registry.example/taxtronik/signal:latest\n'
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=operator-token-with-at-least-thirty-two-chars\n'
  } >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted a mutable latest Signal image"
  fi
  assert_contains "$out" "SIGNAL_IMAGE"
  assert_contains "$out" "versionierten vX.Y.Z-Tag oder sha256-Digest"
  pass "doctor rejects mutable latest for managed Signal"
}

test_doctor_accepts_managed_signal_source_checkout() {
  local env_file="$TMP_DIR/risk-source.env" out="$TMP_DIR/doctor-risk-source.out"
  write_prod_env "$env_file"
  {
    printf 'SIGNAL_DEPLOYMENT=managed\n'
    printf 'SIGNAL_DEPLOY_CHANNEL=source\n'
    printf 'SIGNAL_IMAGE=\n'
    printf 'SIGNAL_GIT_URL=https://git.example/taxtronik/signal.git\n'
    printf 'SIGNAL_GIT_REF=main\n'
    printf 'SIGNAL_GIT_DIR=/opt/signal\n'
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=operator-token-with-at-least-thirty-two-chars\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected managed Signal source checkout"
  }
  assert_contains "$out" "OK       SIGNAL_SOURCE"
  assert_not_contains "$out" "FEHLT    SIGNAL_IMAGE"
  pass "doctor accepts managed Signal from a controlled Git checkout"
}

test_signal_source_identifiers_are_shell_safe_and_secret_free() {
  valid_signal_git_url "https://git.example/taxtronik/signal.git" || test_fail "valid HTTPS Git URL rejected"
  valid_signal_git_url "git@git.example:taxtronik/signal.git" || test_fail "valid SSH Git URL rejected"
  if valid_signal_git_url "https://user:secret@git.example/signal.git" || \
     valid_signal_git_url "https://git.example/signal.git?token=secret"; then
    test_fail "Git URL with embedded credentials was accepted"
  fi
  valid_signal_git_ref "main" || test_fail "valid Signal branch rejected"
  valid_signal_git_ref "refs/tags/v1.2.3" || test_fail "valid Signal tag ref rejected"
  if valid_signal_git_ref "--upload-pack=evil" || valid_signal_git_ref "main@{1}" || valid_signal_git_ref "../main"; then
    test_fail "unsafe Signal Git ref was accepted"
  fi
  pass "Signal source identifiers reject credentials and unsafe refs"
}

test_doctor_rejects_short_risk_layer_operator_token() {
  local env_file="$TMP_DIR/risk-short-operator.env" out="$TMP_DIR/doctor-risk-short-operator.out"
  write_prod_env "$env_file"
  {
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=risk-layer-token-with-at-least-thirty-two-chars\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=too-short\n'
  } >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted a configured but invalid short operator token"
  fi
  assert_contains "$out" "RISK_LAYER_OPERATOR_TOKEN"
  assert_contains "$out" "(< 32)"
  pass "doctor rejects a short configured Risk-Layer operator token"
}

test_doctor_rejects_identical_risk_layer_tokens() {
  local env_file="$TMP_DIR/risk-identical-operator.env" out="$TMP_DIR/doctor-risk-identical-operator.out"
  local shared="shared-risk-layer-token-with-at-least-thirty-two-chars"
  write_prod_env "$env_file"
  {
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_TOKEN=%s\n' "$shared"
    printf 'RISK_LAYER_OPERATOR_TOKEN=%s\n' "$shared"
  } >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted identical Risk-Layer trust-boundary tokens"
  fi
  assert_contains "$out" "muss sich vom Bearer-Token unterscheiden"
  pass "doctor rejects identical Risk-Layer tokens"
}

test_doctor_rejects_signal_values_when_disabled() {
  local env_file="$TMP_DIR/risk-operator-only.env" out="$TMP_DIR/doctor-risk-operator-only.out"
  write_prod_env "$env_file"
  printf 'RISK_LAYER_OPERATOR_TOKEN=operator-token-with-at-least-thirty-two-chars\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted an operator token without Risk-Layer base config"
  fi
  assert_contains "$out" "bei disabled muessen Signal-Werte leer sein"
  pass "doctor rejects Signal credentials while Signal is disabled"
}

test_configure_risk_layer_generates_operator_token() {
  local env_file="$TMP_DIR/risk-setup.env"
  : >"$env_file"
  (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT="managed"
    SIGNAL_DEPLOY_CHANNEL="image"
    SIGNAL_IMAGE="auto"
    RISK_LAYER_URL=""
    RISK_LAYER_TOKEN="risk-layer-token-with-at-least-thirty-two-chars"
    RISK_LAYER_OPERATOR_TOKEN=""
    rand_b64() { printf 'generated-operator-token-with-at-least-32-chars'; }
    configure_risk_layer_interactive
  )
  assert_key_equals "$env_file" SIGNAL_DEPLOYMENT managed
  assert_key_equals "$env_file" SIGNAL_DEPLOY_CHANNEL image
  assert_key_equals "$env_file" SIGNAL_IMAGE auto
  assert_key_equals "$env_file" RISK_LAYER_URL "http://risk-layer:8000"
  assert_key_equals "$env_file" RISK_LAYER_OPERATOR_TOKEN "generated-operator-token-with-at-least-32-chars"
  assert_key_equals "$env_file" RISK_LAYER_FESTWISSEN_DIR ""
  pass "managed Signal setup generates URL and separate secrets"
}

test_configure_external_risk_layer_stays_read_only_without_coordinated_token() {
  local env_file="$TMP_DIR/risk-external-setup.env"
  : >"$env_file"
  (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT="external"
    SIGNAL_DEPLOY_CHANNEL=""
    SIGNAL_IMAGE="auto"
    RISK_LAYER_URL="http://10.10.0.42:8000"
    RISK_LAYER_TOKEN="risk-layer-token-with-at-least-thirty-two-chars"
    RISK_LAYER_OPERATOR_TOKEN=""
    rand_b64() { test_fail "external Risk-Layer must not get a local-only operator secret"; }
    configure_risk_layer_interactive
  )
  assert_key_equals "$env_file" RISK_LAYER_OPERATOR_TOKEN ""
  assert_key_equals "$env_file" SIGNAL_DEPLOYMENT external
  assert_key_equals "$env_file" SIGNAL_IMAGE ""
  assert_key_equals "$env_file" RISK_LAYER_FESTWISSEN_DIR ""
  pass "external Risk-Layer remains read-only without a coordinated operator token"
}

test_managed_signal_requires_distinct_generated_tokens() {
  local env_file="$TMP_DIR/risk-colliding-generated-secrets.env"
  : >"$env_file"
  if (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT="managed"
    SIGNAL_DEPLOY_CHANNEL="image"
    SIGNAL_IMAGE="auto"
    RISK_LAYER_URL=""
    RISK_LAYER_TOKEN="same-generated-secret-with-at-least-thirty-two-chars"
    RISK_LAYER_OPERATOR_TOKEN=""
    rand_b64() { printf 'same-generated-secret-with-at-least-thirty-two-chars'; }
    configure_risk_layer_interactive
  ) >/dev/null 2>&1; then
    test_fail "managed Signal accepted identical generated trust-boundary tokens"
  fi
  pass "managed Signal fails closed when separate secrets cannot be generated"
}

test_external_signal_lifecycle_never_touches_docker() {
  (
    SIGNAL_DEPLOYMENT="external"
    SIGNAL_DEPLOY_CHANNEL=""
    RISK_LAYER_URL="http://10.10.0.42:8000"
    compose() { test_fail "external Signal must never invoke compose: $*"; }
    docker() { test_fail "external Signal must never invoke docker: $*"; }
    provide_signal_for_deploy
    start_signal_for_deploy
  ) >/dev/null
  pass "external Signal is never installed, pulled or restarted by TaxTronik"
}

test_legacy_native_signal_is_inferred_as_external() {
  local mode
  mode="$({
    SIGNAL_DEPLOYMENT=""
    RISK_LAYER_URL="http://10.10.0.42:8000"
    signal_deployment_mode
  })"
  [[ "$mode" == "external" ]] || test_fail "legacy native Signal was inferred as $mode"
  pass "an existing native Signal URL never grants TaxTronik lifecycle ownership"
}

test_managed_signal_lifecycle_uses_pinned_release() {
  local calls="$TMP_DIR/managed-signal-lifecycle.calls"
  : >"$calls"
  (
    SIGNAL_DEPLOYMENT="managed"
    SIGNAL_DEPLOY_CHANNEL="image"
    SIGNAL_IMAGE="auto"
    RISK_LAYER_URL="http://risk-layer:8000"
    RISK_LAYER_TOKEN="risk-layer-token-with-at-least-thirty-two-chars"
    RISK_LAYER_OPERATOR_TOKEN="operator-token-with-at-least-thirty-two-chars"
    compose() { printf 'compose %s\n' "$*" >>"$calls"; }
    docker() {
      printf 'docker %s\n' "$*" >>"$calls"
      [[ "${1:-}" == "inspect" ]] && printf '%s\n' "$SIGNAL_MANAGED_IMAGE_DEFAULT"
      return 0
    }
    provide_signal_for_deploy
    start_signal_for_deploy
  ) >/dev/null
  assert_contains "$calls" "compose --profile risk-layer pull risk-layer"
  assert_contains "$calls" "docker run --rm --entrypoint python $SIGNAL_MANAGED_IMAGE_DEFAULT"
  assert_contains "$calls" "qiskit"
  assert_contains "$calls" "qiskit_aer"
  assert_contains "$calls" "qiskit_ibm_runtime"
  assert_contains "$calls" "compose --profile risk-layer up -d --force-recreate --no-deps --wait --wait-timeout 300 risk-layer"
  pass "managed Signal validates quantum-capable self-contained releases before start"
}

test_managed_signal_source_build_skips_registry_pull() {
  local env_file="$TMP_DIR/managed-signal-source.env" calls="$TMP_DIR/managed-signal-source.calls"
  : >"$env_file"; : >"$calls"
  (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT="managed"
    SIGNAL_DEPLOY_CHANNEL="source"
    SIGNAL_IMAGE=""
    RISK_LAYER_URL="http://risk-layer:8000"
    build_signal_from_source() {
      printf 'source-build\n' >>"$calls"
      export SIGNAL_IMAGE="taxtronik/risk-layer-engine:source-1234567890ab"
    }
    verify_signal_managed_image() { printf 'verify %s %s\n' "$1" "$2" >>"$calls"; }
    compose() {
      [[ "$*" != *" pull "* && "$*" != *" pull" ]] || test_fail "source Signal invoked registry pull"
      printf 'compose %s\n' "$*" >>"$calls"
    }
    docker() {
      [[ "${1:-}" == "inspect" ]] && return 0
      printf 'docker %s\n' "$*" >>"$calls"
    }
    provide_signal_for_deploy
    start_signal_for_deploy
  ) >/dev/null
  assert_contains "$calls" "source-build"
  assert_contains "$calls" "verify taxtronik/risk-layer-engine:source-1234567890ab source"
  assert_contains "$calls" "compose --profile risk-layer up -d --force-recreate --no-deps --wait --wait-timeout 300 risk-layer"
  assert_key_equals "$env_file" SIGNAL_IMAGE taxtronik/risk-layer-engine:source-1234567890ab
  pass "managed Signal source channel builds locally and never pulls a registry image"
}

test_managed_signal_source_build_accepts_fresh_no_checkout_clone() {
  local origin="$TMP_DIR/signal-source-origin" checkout="$TMP_DIR/signal-source-checkout"
  local interrupted_checkout="$TMP_DIR/signal-source-interrupted-checkout"
  local build_root="$TMP_DIR/signal-source-build-root" out="$TMP_DIR/signal-source-dirty.out"
  mkdir -p "$origin/scripts" "$build_root"
  git -C "$origin" init -q -b main
  git -C "$origin" config user.name TaxTronik-Test
  git -C "$origin" config user.email test@taxtronik.invalid
  printf 'signal source\n' >"$origin/README.md"
  printf '#!/bin/sh\nexit 0\n' >"$origin/scripts/build-managed-image.sh"
  git -C "$origin" add README.md scripts/build-managed-image.sh
  git -C "$origin" commit -qm initial

  (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$checkout"
    SIGNAL_BUILD_MEMORY_LIMIT=3g
    SIGNAL_BUILD_MEMORY_RESERVE=1g
    SIGNAL_BUILD_CPUS=2
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    build_signal_from_source
    [[ "$SIGNAL_IMAGE" == taxtronik/risk-layer-engine:source-* ]] || \
      test_fail "fresh Signal source clone did not produce a commit-derived image"
  ) >/dev/null
  [[ -f "$checkout/README.md" ]] || test_fail "fresh Signal clone was not checked out"

  git clone -q --no-checkout "$origin" "$interrupted_checkout"
  (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$interrupted_checkout"
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    build_signal_from_source
  ) >/dev/null
  [[ -f "$interrupted_checkout/README.md" ]] || \
    test_fail "interrupted no-checkout Signal clone was not recovered"

  printf 'operator-owned file\n' >"$checkout/local-note.txt"
  if (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$checkout"
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    build_signal_from_source
  ) >"$out" 2>&1; then
    test_fail "managed Signal source build accepted an existing dirty checkout"
  fi
  assert_contains "$out" "Signal-Checkout enthaelt lokale Aenderungen"
  pass "managed Signal source build checks out fresh clones but preserves existing local work"
}

test_signal_embedding_compose_contract_is_self_contained_and_offline() {
  local service="$TMP_DIR/risk-layer-compose-service.yml"
  sed -n '/^  risk-layer:/,/^  eric-bridge:/p' \
    "$REPO_ROOT/infra/compose/docker-compose.app.yml" >"$service"
  assert_contains "$service" "working_dir: /release"
  assert_contains "$service" 'image: ${SIGNAL_IMAGE:-git.hirschmann-koxha.de/taxtronik/risk-layer-engine:v0.1.0}'
  assert_not_contains "$service" "RISK_LAYER_FESTWISSEN_DIR"
  assert_contains "$service" "RISK_LAYER_EMBEDDING_MODEL: /release/models/bge-m3"
  assert_contains "$service" "RISK_LAYER_EMBEDDING_OFFLINE: '1'"
  assert_contains "$service" "HF_HUB_OFFLINE: '1'"
  assert_contains "$service" "TRANSFORMERS_OFFLINE: '1'"
  assert_contains "$service" "- /release/catalog/begriffe.yaml"
  assert_contains "$service" "- /release/corpus/graph.sqlite"
  assert_contains "$service" "- risk_layer_definitionen:/app/definitionen"
  assert_contains "$service" "- risk_layer_embedding_state:/state/embedding"
  assert_contains "$service" "- risk_layer_embedding_cache:/cache"
  assert_not_contains "$service" "/data/katalog"
  assert_not_contains "$service" "/data/corpus"
  pass "Signal Compose contract stays self-contained, persistent and offline"
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

fake_resource_docker_path() {
  local bin_dir="$1" log_file="$2"
  mkdir -p "$bin_dir"
  cat >"$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-} ${2:-}" == "build --help" ]]; then
  if [[ "${DOCKER_RESOURCE_HELP:-yes}" == "yes" ]]; then
    printf '      --resource stringArray   Resource limits for build containers\n'
  else
    printf 'Usage: docker build [OPTIONS] PATH\n'
  fi
  exit 0
fi
printf '%s\n' "$*" >>"$DOCKER_LOG"
exit "${DOCKER_EXIT:-0}"
EOF
  chmod +x "$bin_dir/docker"
  : >"$log_file"
}

test_build_images_enforces_hard_memory_and_swap_limit() {
  local root="$TMP_DIR/build-resource-root" bin_dir="$TMP_DIR/bin-build-resource"
  local log_file="$TMP_DIR/docker-build-resource.log" out="$TMP_DIR/build-resource.out"
  mkdir -p "$root"
  fake_resource_docker_path "$bin_dir" "$log_file"

  (
    ROOT="$root"
    PATH="$bin_dir:$PATH"
    DOCKER_LOG="$log_file"
    TAXTRONIK_BUILD_MEMORY_LIMIT=2500m
    TAXTRONIK_BUILD_MEMORY_RESERVE=512m
    export PATH DOCKER_LOG TAXTRONIK_BUILD_MEMORY_LIMIT TAXTRONIK_BUILD_MEMORY_RESERVE
    image_tag() { printf 'test-version'; }
    host_available_memory_kib() { printf '8388608\n'; }
    prune_build_cache() { :; }
    build_images
  ) >"$out" 2>&1 || {
    cat "$out" >&2
    test_fail "resource-limited image build failed"
  }

  [[ "$(grep -Fc -- '--resource memory=2500m --resource memory-swap=2500m' "$log_file")" == "2" ]] || {
    cat "$log_file" >&2
    test_fail "expected hard memory and no-swap limit on both image builds"
  }
  assert_contains "$log_file" "Dockerfile.web"
  assert_contains "$log_file" "Dockerfile.worker"
  assert_contains "$out" "RAM-Schutz: Build maximal 2500m ohne Swap"
  pass "local image builds enforce cgroup memory and disable build swap"
}

test_build_images_refuses_insufficient_host_memory() {
  local root="$TMP_DIR/build-low-memory-root" bin_dir="$TMP_DIR/bin-build-low-memory"
  local log_file="$TMP_DIR/docker-build-low-memory.log" out="$TMP_DIR/build-low-memory.out"
  mkdir -p "$root"
  fake_resource_docker_path "$bin_dir" "$log_file"

  if (
    ROOT="$root"
    PATH="$bin_dir:$PATH"
    DOCKER_LOG="$log_file"
    export PATH DOCKER_LOG
    image_tag() { printf 'test-version'; }
    host_available_memory_kib() { printf '3145728\n'; }
    build_images
  ) >"$out" 2>&1; then
    test_fail "local build started without memory limit plus system reserve"
  fi

  assert_contains "$out" "Lokalbuild wegen RAM-Schutz abgebrochen"
  assert_contains "$out" "erforderlich 4096 MiB"
  assert_not_contains "$log_file" "Dockerfile.web"
  pass "local image build fails before work when host memory is insufficient"
}

test_build_images_refuses_unsafe_legacy_buildx() {
  local root="$TMP_DIR/build-old-buildx-root" bin_dir="$TMP_DIR/bin-build-old-buildx"
  local log_file="$TMP_DIR/docker-build-old-buildx.log" out="$TMP_DIR/build-old-buildx.out"
  mkdir -p "$root"
  fake_resource_docker_path "$bin_dir" "$log_file"

  if (
    ROOT="$root"
    PATH="$bin_dir:$PATH"
    DOCKER_LOG="$log_file"
    DOCKER_RESOURCE_HELP=no
    export PATH DOCKER_LOG DOCKER_RESOURCE_HELP
    image_tag() { printf 'test-version'; }
    host_available_memory_kib() { printf '8388608\n'; }
    build_images
  ) >"$out" 2>&1; then
    test_fail "local build used Buildx without hard resource limits"
  fi

  assert_contains "$out" "Sicherer Lokalbuild verweigert"
  assert_not_contains "$log_file" "Dockerfile.web"
  pass "local image build fails closed on Buildx without resource limits"
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
    database_has_gwg_invariants_for_checkout() { return 0; }
    docker() { return 0; }
    deploy_readiness
  ) >"$out" 2>&1; then
    test_fail "deploy_readiness silently skipped missing host ports"
  fi
  assert_contains "$out" "Hostports nicht ermittelbar"
  pass "deploy readiness fails closed when host ports are unavailable"
}

test_deploy_readiness_rejects_gwg_schema_drift() {
  local out="$TMP_DIR/readiness-gwg-drift.out"
  if (
    database_has_gwg_invariants_for_checkout() { return 1; }
    docker() { test_fail "host ports must not be inspected after GwG schema drift"; }
    deploy_readiness
  ) >"$out" 2>&1; then
    test_fail "deploy_readiness accepted an incomplete GwG protection schema"
  fi
  assert_contains "$out" "GwG-Datenbankschutz entspricht nicht dem Migrationsstand"
  pass "deploy readiness fails closed on GwG schema drift"
}

test_run_migrations_blocks_incomplete_gwg_schema_before_writer_start() {
  local out="$TMP_DIR/migrate-gwg-drift.out" steps="$TMP_DIR/migrate-gwg-drift.steps"
  if (
    begin_migration_transition() { printf 'pending\n' >>"$steps"; }
    compose() { printf 'migrate\n' >>"$steps"; }
    database_has_gwg_invariants_for_checkout() {
      printf 'gwg-integrity\n' >>"$steps"
      return 1
    }
    run_migrations
    printf 'writer-start\n' >>"$steps"
  ) >"$out" 2>&1; then
    test_fail "run_migrations accepted an incomplete GwG protection schema"
  fi

  assert_file_equals "$steps" $'pending\nmigrate\ngwg-integrity'
  assert_contains "$out" "GwG-Datenbankschutz ist unvollstaendig; neue Writer werden nicht aktiviert"
  assert_not_contains "$steps" "writer-start"
  pass "migration flow validates GwG guards before any writer can start"
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

test_host_tool_deps_refresh_stale_checkout() {
  local root="$TMP_DIR/host-deps" steps="$TMP_DIR/host-deps.steps"
  local synced="$TMP_DIR/host-deps.synced"
  mkdir -p "$root"
  : >"$steps"

  (
    ROOT="$root"
    host_tool_deps_ready() { return 0; }
    require_cmd() { :; }
    pnpm() {
      printf 'pnpm %s\n' "$*" >>"$steps"
      if [[ "${1:-}" == "install" ]]; then
        : >"$synced"
        return 0
      fi
      [[ -f "$synced" ]]
    }
    ensure_host_tool_deps
  ) >/dev/null 2>&1 || test_fail "stale host dependencies were not refreshed"

  assert_contains "$steps" "pnpm install --frozen-lockfile --prod=false"
  [[ "$(grep -Fc 'pnpm --filter @taxtronik/storage exec node -e process.exit(0)' "$steps")" == "2" ]] || {
    cat "$steps" >&2
    test_fail "expected freshness probes before and after pnpm install"
  }
  pass "host tools refresh stale injected workspace dependencies"
}

test_run_backup_uses_resolved_host_path() {
  local root="$TMP_DIR/run-backup-host-root"
  local captured="$TMP_DIR/run-backup-host-path"
  mkdir -p "$root/infra/compose"

  (
    ROOT="$root"
    BACKUP_HOST_DIR="../../operator-backups"
    BACKUP_LOCAL_DIR="/app/backups"
    require_cmd() { :; }
    generate_prisma_client_for_host_tools() { :; }
    pg_dump() { :; }
    ensure_s3_ready_for_backup() { :; }
    pnpm() { printf '%s\n' "$BACKUP_LOCAL_DIR" >"$captured"; }
    run_backup
  ) >/dev/null

  assert_file_equals "$captured" "$root/operator-backups"
  pass "host backup maps the compose backup directory instead of using the container path"
}

test_run_backup_respects_explicit_staging_path() {
  local root="$TMP_DIR/run-backup-staging-root"
  local staging="$TMP_DIR/run-backup-staging"
  local captured="$TMP_DIR/run-backup-staging-path"
  mkdir -p "$root" "$staging"

  (
    ROOT="$root"
    BACKUP_LOCAL_DIR="/app/backups"
    require_cmd() { :; }
    generate_prisma_client_for_host_tools() { :; }
    pg_dump() { :; }
    ensure_s3_ready_for_backup() { :; }
    pnpm() { printf '%s\n' "$BACKUP_LOCAL_DIR" >"$captured"; }
    run_backup "$staging"
  ) >/dev/null

  assert_file_equals "$captured" "$staging"
  pass "full backup can override the host backup target with its staging directory"
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
  git() {
    record_step "git $*"
    record_step "git-umask $(umask) $*"
  }
  deployment_git_remote() { printf 'origin'; }
  ensure_host_tool_deps() { record_step ensure-host-deps; }
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
  assert_before "$sequence" "git merge --ff-only origin/main" "ensure-host-deps"
  assert_before "$sequence" "ensure-host-deps" "provide-images"
  assert_contains "$sequence" "git-umask 0022 merge --ff-only origin/main"
  assert_contains "$sequence" "git-umask 0077 fetch origin"
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
    ensure_managed_n8n_connection() { :; }
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
  ensure_host_tool_deps() { :; }
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

test_migration_transition_retargets_only_verified_gwg_034_recovery() {
  local state_file="$TMP_DIR/transition-gwg-034.state"
  local marker="$TMP_DIR/transition-gwg-034.pending"
  local out="$TMP_DIR/transition-gwg-034.out" source_commit old_target_commit new_target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"
  write_release_state "$state_file"
  cat >"$marker" <<EOF
source_version=2.0.0
source_commit=$source_commit
target_version=2.5.0
target_commit=$old_target_commit
requires_db_restore=true
EOF

  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-gwg-034.no-restore"
    TAXTRONIK_VERSION=3.0.0
    TAXTRONIK_RELEASE_COMMIT="$new_target_commit"
    pending_database_migration_requirement() { printf 'false'; }
    can_retarget_recoverable_gwg_034_transition() { return 0; }
    begin_migration_transition
  ) >"$out" 2>&1

  assert_key_equals "$marker" source_version 2.0.0
  assert_key_equals "$marker" source_commit "$source_commit"
  assert_key_equals "$marker" target_version 3.0.0
  assert_key_equals "$marker" target_commit "$new_target_commit"
  assert_key_equals "$marker" requires_db_restore true
  assert_contains "$out" "GwG-Migrationsuebergang 03400"
  pass "verified GwG 034 recovery can advance the pending target without weakening it"
}

test_migration_transition_retargets_manually_recovered_legacy_target_before_new_migration() {
  local state_file="$TMP_DIR/transition-gwg-034-manual.state"
  local marker="$TMP_DIR/transition-gwg-034-manual.pending"
  local out="$TMP_DIR/transition-gwg-034-manual.out" old_target_commit new_target_commit
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"
  cat >"$state_file" <<'EOF'
current=2026-06-16
current_commit=
current_rollback_requires_db_restore=true
EOF
  cat >"$marker" <<EOF
source_version=2026-06-16
source_commit=
target_version=2026-06-16
target_commit=$old_target_commit
requires_db_restore=true
EOF

  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-gwg-034-manual.no-restore"
    TAXTRONIK_VERSION=2026-06-16
    TAXTRONIK_RELEASE_COMMIT="$new_target_commit"
    # Der neue Vorwaerts-Commit bringt eine weitere Migration mit. Das muss den
    # relativ zum alten Marker-Ziel vollstaendig migrierten Stand nicht sperren.
    pending_database_migration_requirement() { printf 'true'; }
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 1; }
    database_is_fully_migrated_for_commit() { [[ "$1" == "$old_target_commit" ]]; }
    begin_migration_transition
  ) >"$out" 2>&1

  assert_key_equals "$marker" source_version 2026-06-16
  assert_key_equals "$marker" source_commit ""
  assert_key_equals "$marker" target_version 2026-06-16
  assert_key_equals "$marker" target_commit "$new_target_commit"
  assert_key_equals "$marker" requires_db_restore true
  assert_contains "$out" "GwG-Migrationsuebergang 03400"
  pass "manually recovered legacy target can advance to a successor migration without weakening restore"
}

test_migration_transition_captures_legacy_update_source_commit() {
  local state_file="$TMP_DIR/transition-legacy-source.state"
  local marker="$TMP_DIR/transition-legacy-source.pending"
  local source_commit target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  target_commit="$(printf 'd%.0s' {1..40})"
  cat >"$state_file" <<'EOF'
current=2026-06-16
current_commit=
current_rollback_requires_db_restore=true
EOF

  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-legacy-source.no-restore"
    TAXTRONIK_VERSION=2026-06-16
    TAXTRONIK_RELEASE_COMMIT="$target_commit"
    _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT="$source_commit"
    pending_database_migration_requirement() { printf 'false'; }
    begin_migration_transition
  ) >/dev/null

  assert_key_equals "$marker" source_version 2026-06-16
  assert_key_equals "$marker" source_commit "$source_commit"
  assert_key_equals "$marker" target_commit "$target_commit"
  pass "first legacy update captures its pre-merge checkout as source commit"
}

test_manual_gwg_034_resolution_requires_schema_invariants() {
  local old_target_commit
  old_target_commit="$(printf 'c%.0s' {1..40})"

  if (
    git() { printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction; }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction
      elif [[ "$*" == *"gwg_034_schema_invariants"* ]]; then
        # Simuliert `prisma migrate resolve --applied`, ohne die 034-DDL
        # tatsaechlich ausgefuehrt zu haben.
        printf 'no'
      else
        return 1
      fi
    }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ); then
    test_fail "finished GwG 034 journal without schema invariants was accepted"
  fi

  (
    git() { printf '%s\n' 20260801003300_pre_gwg_hardening; }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' 20260801003300_pre_gwg_hardening
      else
        return 1
      fi
    }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ) || test_fail "pre-GwG-034 target was incorrectly required to expose 034 invariants"

  pass "manual GwG 034 resolution requires the real schema while pre-034 targets remain valid"
}

test_gwg_identity_invariant_contract_covers_schema_and_guards() {
  local query="$TMP_DIR/gwg-identity-invariants.sql"

  (
    compose() {
      printf '%s\n' "$*" >"$query"
      printf 'yes\n'
    }
    database_has_gwg_identity_invariants
  ) || test_fail "complete GwG identity invariant probe was rejected"

  assert_contains "$query" "gwg_043_schema_invariants"
  assert_contains "$query" "identity_assignment_required"
  assert_contains "$query" "document_set_id"
  assert_contains "$query" "natural_client_subject_id"
  assert_contains "$query" "beneficial_owner_subject_id"
  assert_contains "$query" "representative_subject_id"
  assert_contains "$query" "identity_assignment_confirmed_at"
  assert_contains "$query" "identity_assignment_confirmed_by"
  assert_contains "$query" "public.gwg_representative"
  assert_contains "$query" "app.guard_gwg_id_document_subject_and_set()"
  assert_contains "$query" "app.enforce_gwg_document_set_consistency()"
  assert_contains "$query" "app.gwg_check_has_confirmed_identity(uuid)"
  assert_contains "$query" "app.enforce_gwg_identity_assignment_on_verification()"
  assert_contains "$query" "app.invalidate_gwg_beneficial_owner_identity_assignment()"
  assert_contains "$query" "gwg_id_document_subject_and_set_guard"
  assert_contains "$query" "gwg_document_set_consistency"
  assert_contains "$query" "00_gwg_check_identity_verification_guard"
  assert_contains "$query" "gwg_beneficial_owner_identity_assignment_invalidate"

  if (
    compose() { printf 'no\n'; }
    database_has_gwg_identity_invariants
  ); then
    test_fail "GwG identity invariant probe accepted a negative database result"
  fi

  pass "GwG identity invariant contract covers schema, functions and active guards"
}

test_gwg_044_invariant_requires_immutable_evidence_versions() {
  local query="$TMP_DIR/gwg-044-invariants.sql"

  (
    compose() {
      printf '%s\n' "$*" >"$query"
      printf 'yes\n'
    }
    database_has_gwg_044_invariants
  ) || test_fail "complete GwG 044 invariant probe was rejected"

  assert_contains "$query" "gwg_044_schema_invariants"
  assert_contains "$query" "app.block_version_during_gwg_destruction()"
  assert_contains "$query" "public.\"gwg_id_document\""
  assert_contains "$query" "app.gwg_destroy_document_id"
  assert_contains "$query" "authorized_delete"
  assert_contains "$query" "FOR UPDATE"
  assert_contains "$query" "document_version_block_gwg_destruction"

  if (
    compose() { printf 'no\n'; }
    database_has_gwg_044_invariants
  ); then
    test_fail "GwG 044 invariant probe accepted the legacy evidence-version guard"
  fi

  pass "GwG 044 invariant requires immutable assigned evidence versions"
}

test_manual_gwg_identity_resolution_requires_schema_invariants() {
  local target_commit reached_044="$TMP_DIR/gwg-044-recovery-reached"
  target_commit="$(printf 'c%.0s' {1..40})"

  if (
    git() {
      printf '%s\n' \
        20260801003400_gwg_fail_closed_and_destruction \
        20260801004300_gwg_identity_subjects_and_document_sets \
        20260801004400_legacy_gwg_guard_recovery
    }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no\n'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' \
          20260801003400_gwg_fail_closed_and_destruction \
          20260801004300_gwg_identity_subjects_and_document_sets \
          20260801004400_legacy_gwg_guard_recovery
      elif [[ "$*" == *"gwg_034_schema_invariants"* ]]; then
        printf 'yes\n'
      elif [[ "$*" == *"gwg_043_schema_invariants"* ]]; then
        printf 'no\n'
      else
        return 1
      fi
    }
    database_is_fully_migrated_for_commit "$target_commit"
  ); then
    test_fail "finished GwG 043/044 journal without identity schema invariants was accepted"
  fi

  (
    git() {
      printf '%s\n' \
        20260801003400_gwg_fail_closed_and_destruction \
        20260801004300_gwg_identity_subjects_and_document_sets \
        20260801004400_legacy_gwg_guard_recovery
    }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no\n'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' \
          20260801003400_gwg_fail_closed_and_destruction \
          20260801004300_gwg_identity_subjects_and_document_sets \
          20260801004400_legacy_gwg_guard_recovery
      elif [[ "$*" == *"gwg_034_schema_invariants"* ||
              "$*" == *"gwg_043_schema_invariants"* ]]; then
        printf 'yes\n'
      elif [[ "$*" == *"gwg_044_schema_invariants"* ]]; then
        printf 'seen\n' >"$reached_044"
        printf 'yes\n'
      else
        return 1
      fi
    }
    database_is_fully_migrated_for_commit "$target_commit"
  ) || test_fail "complete GwG 043/044 schema invariants were rejected"
  [[ -s "$reached_044" ]] || test_fail "GwG 044 recovery skipped its version-guard invariant"

  pass "manual GwG 043/044 resolution requires the real identity protection schema"
}

test_gwg_034_retarget_requires_exact_forward_state() {
  local source_commit old_target_commit new_target_commit other_source_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"
  other_source_commit="$(printf 'e%.0s' {1..40})"

  (
    git() {
      [[ "$*" == *"ls-tree -d --name-only"* ]] || return 1
      printf '%s\n' \
        20260801003400_gwg_fail_closed_and_destruction \
        20260801004000_poa_created_at_db_clock
    }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' \
          20260801003400_gwg_fail_closed_and_destruction \
          20260801004000_poa_created_at_db_clock
      elif [[ "$*" == *"gwg_034_schema_invariants"* ]]; then
        printf 'yes'
      else
        return 1
      fi
    }
    # Eine neue Migration im aktuellen Vorwaerts-Checkout darf die bestaetigte
    # Vollstaendigkeit des alten Marker-Ziels nicht entkraeften.
    pending_database_migration_requirement() { printf 'true'; }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ) || test_fail "fully migrated marker target was rejected because its successor has a new migration"

  if (
    git() { printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction; }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then printf 'yes';
      else printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction; fi
    }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ); then
    test_fail "open Prisma journal was accepted as fully migrated"
  fi

  if (
    git() {
      printf '%s\n' \
        20260801003400_gwg_fail_closed_and_destruction \
        20260801004000_poa_created_at_db_clock
    }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then printf 'no';
      else printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction; fi
    }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ); then
    test_fail "marker target with a missing historical migration was accepted as fully migrated"
  fi

  (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2.0.0 "$source_commit" 2.5.0 "$old_target_commit" \
      2.0.0 "$source_commit" 3.0.0 "$new_target_commit"
  ) || test_fail "exact GwG 034 forward recovery was rejected"

  (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "$source_commit" 2026-06-16 "$old_target_commit" \
      2026-06-16 "$source_commit" 2026-06-16 "$new_target_commit"
  ) || test_fail "same non-SemVer release tag rejected a forward fix commit"

  (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      source-bbbbbbbbbbbb "$source_commit" source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" source-dddddddddddd "$new_target_commit"
  ) || test_fail "automatic source commit identities blocked a forward recovery"

  (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "" 2026-06-16 "$old_target_commit" \
      2026-06-16 "" 2026-06-16 "$new_target_commit" true
  ) || test_fail "recoverable legacy transition without source commit was rejected"

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "" 2026-06-16 "$old_target_commit" \
      2026-06-16 "" 2026-06-16 "$new_target_commit" false
  ); then
    test_fail "legacy transition without source commit bypassed its restore requirement"
  fi

  (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 1; }
    database_is_fully_migrated_for_commit() { [[ "$1" == "$old_target_commit" ]]; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "" 2026-06-16 "$old_target_commit" \
      2026-06-16 "" 2026-06-16 "$new_target_commit" true
  ) || test_fail "fully migrated legacy recovery transition was rejected"

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 1; }
    database_is_fully_migrated_for_commit() { return 1; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "" 2026-06-16 "$old_target_commit" \
      2026-06-16 "" 2026-06-16 "$new_target_commit" true
  ); then
    test_fail "legacy transition advanced while database migrations were not current"
  fi

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2.0.0 "$source_commit" 2.5.0 "$old_target_commit" \
      2.0.0 "$other_source_commit" 3.0.0 "$new_target_commit"
  ); then
    test_fail "GwG 034 recovery accepted a different source commit"
  fi

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2.0.0 "$source_commit" 2.5.0 "$old_target_commit" \
      2.0.0 "$source_commit" 2.4.0 "$new_target_commit"
  ); then
    test_fail "GwG 034 recovery accepted a version downgrade"
  fi

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 0; }
    can_retarget_recoverable_gwg_034_transition \
      2026-06-16 "$source_commit" 2026-06-16 "$old_target_commit" \
      2026-06-16 "$source_commit" 2026-06-17 "$new_target_commit"
  ); then
    test_fail "GwG 034 recovery accepted an incomparable release-tag change"
  fi

  if (
    git() { return 0; }
    gwg_034_migration_is_fixed() { return 0; }
    database_has_recoverable_gwg_034_failure() { return 1; }
    can_retarget_recoverable_gwg_034_transition \
      2.0.0 "$source_commit" 2.5.0 "$old_target_commit" \
      2.0.0 "$source_commit" 3.0.0 "$new_target_commit"
  ); then
    test_fail "GwG 034 recovery accepted an unverified database state"
  fi

  gwg_034_migration_is_fixed || test_fail "migration 034 safety signature is incomplete"
  pass "GwG 034 pending retarget requires the exact forward and database state"
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
test_doctor_accepts_complete_traefik_contract
test_doctor_rejects_unsafe_traefik_proxy_trust
test_doctor_rejects_n8n_on_an_application_domain
test_initial_setup_confirmation_and_atomic_plan_application
test_deploy_provisions_managed_n8n_in_acp
test_one_click_blank_host_guard_rejects_existing_containers
test_one_click_blank_host_guard_rejects_unreachable_docker
test_one_click_blank_host_allows_missing_docker_for_deferred_install
test_source_channel_derives_version_from_checkout_without_semver
test_deployment_channel_is_explicit_with_legacy_prefix_fallback
test_cli_presents_deploy_as_primary_path
test_bootstrap_installs_one_click_requirements_after_configuration
test_existing_one_click_deploy_does_not_reapply_blank_host_gate
test_interrupted_one_click_deploy_resumes_only_owned_containers
test_interrupted_one_click_deploy_still_rejects_foreign_containers
test_one_click_runtime_install_contract_is_pinned_and_official
test_one_click_replaces_incomplete_docker_only_after_blank_host_gate
test_traefik_dynamic_route_and_compose_contract_are_socketless
test_traefik_lifecycle_is_part_of_activation
test_full_backup_snapshots_managed_traefik_acme_volume
test_doctor_accepts_internal_risk_layer_without_fetch_allowlist
test_doctor_rejects_incomplete_risk_layer_pair
test_doctor_warns_for_missing_risk_layer_operator_token_without_failing
test_doctor_accepts_self_contained_managed_signal
test_doctor_rejects_managed_signal_latest_image
test_doctor_accepts_managed_signal_source_checkout
test_signal_source_identifiers_are_shell_safe_and_secret_free
test_doctor_rejects_short_risk_layer_operator_token
test_doctor_rejects_identical_risk_layer_tokens
test_doctor_rejects_signal_values_when_disabled
test_configure_risk_layer_generates_operator_token
test_configure_external_risk_layer_stays_read_only_without_coordinated_token
test_managed_signal_requires_distinct_generated_tokens
test_external_signal_lifecycle_never_touches_docker
test_legacy_native_signal_is_inferred_as_external
test_managed_signal_lifecycle_uses_pinned_release
test_managed_signal_source_build_skips_registry_pull
test_managed_signal_source_build_accepts_fresh_no_checkout_clone
test_signal_embedding_compose_contract_is_self_contained_and_offline
test_prune_build_cache_calls_docker_builder_prune
test_prune_build_cache_can_be_disabled
test_prune_build_cache_failure_is_non_blocking
test_build_images_enforces_hard_memory_and_swap_limit
test_build_images_refuses_insufficient_host_memory
test_build_images_refuses_unsafe_legacy_buildx
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
test_deploy_readiness_rejects_gwg_schema_drift
test_run_migrations_blocks_incomplete_gwg_schema_before_writer_start
test_backup_manifest_detects_tampering
test_host_tool_deps_refresh_stale_checkout
test_run_backup_uses_resolved_host_path
test_run_backup_respects_explicit_staging_path
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
test_migration_transition_retargets_only_verified_gwg_034_recovery
test_migration_transition_retargets_manually_recovered_legacy_target_before_new_migration
test_migration_transition_captures_legacy_update_source_commit
test_manual_gwg_034_resolution_requires_schema_invariants
test_gwg_identity_invariant_contract_covers_schema_and_guards
test_gwg_044_invariant_requires_immutable_evidence_versions
test_manual_gwg_identity_resolution_requires_schema_invariants
test_gwg_034_retarget_requires_exact_forward_state
test_compose_writer_passthrough_is_blocked_by_recovery_markers
test_internal_writer_activation_is_bound_to_exact_contract
test_full_backup_cannot_start_n8n_behind_restore_barrier
test_restore_rollback_requires_explicit_matching_version
test_inherited_internal_authorization_is_sanitized
test_identical_redeploy_preserves_previous_state
test_min_previous_without_state_fails_for_existing_installation
test_secret_files_are_mode_0600

printf '\n%s ops-lib tests passed.\n' "$TESTS_RUN"
