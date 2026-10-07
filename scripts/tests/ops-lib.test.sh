#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../ops-lib.sh
source "$REPO_ROOT/scripts/ops-lib.sh"
NODE_BIN="$(command -v node 2>/dev/null || command -v node.exe)"

# Quelltext der Operator-CLI fuer Inhaltspruefungen: ops-lib.sh und die von ihr
# gesourcten Domaenendateien unter scripts/ops/.
OPS_SOURCES="$TMP_DIR/ops-sources.sh"
cat "$REPO_ROOT/scripts/ops-lib.sh" "$REPO_ROOT"/scripts/ops/*.sh >"$OPS_SOURCES"

node_host() {
  local args=() arg
  for arg in "$@"; do
    if [[ "$NODE_BIN" == *.exe && "$arg" == /* ]]; then args+=("$(wslpath -w "$arg")")
    else args+=("$arg"); fi
  done
  "$NODE_BIN" "${args[@]}"
}

TESTS_RUN=0
TESTS_SKIPPED=0

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

# Nur fuer Tests, deren Werkzeug lokal fehlen darf; in CI erzwingt der Aufrufer
# das Werkzeug (siehe s04_signature_tools_available).
skip_test() {
  TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
  printf 'skip - %s (%s)\n' "$1" "$2"
}

# Jeder Test laeuft in einer eigenen Subshell mit aktivem errexit: test_fail,
# ein fehlschlagender Befehl oder eine ungesetzte Variable beenden nur diesen
# Test, und der Lauf setzt mit dem naechsten fort. Die Subshell meldet ihre
# Zaehler ueber eine Datei zurueck; ein Test ohne pass/skip gilt als
# fehlgeschlagen. Am Ende stehen alle Fehlschlaege mit Anzahl, Exit 1.
TESTS_FAILED=0
FAILED_TESTS=()

run_test() {
  local name="$1" status=0 counters="$TMP_DIR/.run-test-counters" run skipped
  rm -f -- "$counters"
  set +e
  (
    set -e
    "$name"
    printf '%s %s\n' "$TESTS_RUN" "$TESTS_SKIPPED" >"$counters"
  )
  status=$?
  set -e
  if (( status == 0 )) && [[ -s "$counters" ]]; then
    read -r run skipped <"$counters"
    if (( run + skipped > TESTS_RUN + TESTS_SKIPPED )); then
      TESTS_RUN="$run"
      TESTS_SKIPPED="$skipped"
      return 0
    fi
    printf 'not ok - %s (ohne pass/skip beendet)\n' "$name" >&2
  else
    printf 'not ok - %s (Exit %s)\n' "$name" "$status" >&2
  fi
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILED_TESTS+=("$name")
}

# ---------------------------------------------------------------------------
# GwG-Invarianten: Ersatz nur fuer `docker compose exec postgres psql`.
# Der echte Aufrufpfad (run_gwg_invariant_check) bleibt aktiv; der Stub prueft
# den exakten psql-Aufruf, verlangt auf stdin byte-genau eine versionierte Datei
# aus packages/db/invariants/gwg und antwortet wie psql -At: eine Zeile je
# Verletzung, keine Zeile = erfuellt. Antworten je Datei kommen aus
# GWG_ANSWER_034/043/044 (leer = erfuellt, EMPTY_ROW = Zeile ohne Namen,
# ERROR = SQL-Fehler mit psql-Exit 3). GWG_CALLS protokolliert die Dateien.
# Gegen eine echte Datenbank laufen dieselben Dateien in
# packages/db/src/__tests__/db-invariants.test.ts.
# ---------------------------------------------------------------------------
GWG_INVARIANT_DIR="$REPO_ROOT/packages/db/invariants/gwg"
GWG_INVARIANT_PSQL=(--infra exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on' postgres
  psql -X -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -At -f -)

is_gwg_invariant_psql() {
  local index=0 arg
  [[ "$#" -eq "${#GWG_INVARIANT_PSQL[@]}" ]] || return 1
  for arg in "$@"; do
    [[ "$arg" == "${GWG_INVARIANT_PSQL[$index]}" ]] || return 1
    index=$((index + 1))
  done
}

gwg_invariant_from_stdin() {
  local sql file
  sql="$(cat; printf .)"
  for file in "$GWG_INVARIANT_DIR"/*.sql; do
    if [[ "$sql" == "$(cat "$file"; printf .)" ]]; then
      printf '%s\n' "${file##*/}"
      return 0
    fi
  done
  printf 'stdin ist keine versionierte GwG-Invariantendatei\n' >&2
  return 1
}

fake_gwg_invariant_psql() {
  local file answer
  if ! is_gwg_invariant_psql "$@"; then
    printf 'unerwarteter compose-Aufruf: %s\n' "$*" >&2
    return 1
  fi
  file="$(gwg_invariant_from_stdin)" || return 1
  printf '%s\n' "$file" >>"${GWG_CALLS:-/dev/null}"
  case "$file" in
    034-*) answer="${GWG_ANSWER_034:-}" ;;
    043-*) answer="${GWG_ANSWER_043:-}" ;;
    044-*) answer="${GWG_ANSWER_044:-}" ;;
    *) answer="" ;;
  esac
  case "$answer" in
    "") ;;
    EMPTY_ROW) printf '\n' ;;
    ERROR)
      printf 'psql:<stdin>:7: ERROR:  relation "information_schema.columns" does not exist\n' >&2
      return 3
      ;;
    *) printf '%s\n' "$answer" ;;
  esac
}

# Produktion laeuft nur im Release-Kanal (S-04, Entscheidung C); Source-Tests
# setzen den Kanal ausdruecklich.
write_prod_env() {
  local file="$1"
  cat >"$file" <<'EOF'
NODE_ENV=production
TAXTRONIK_DEPLOY_CHANNEL=release
TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
TAXTRONIK_VERSION=1.2.3
AUTH_SECRET=auth-secret-with-at-least-thirty-two-chars
SECRET_BOX_KEY=secret-box-key-with-at-least-thirty-two-chars
N8N_HMAC_SECRET=n8n-hmac-secret-with-at-least-thirty-two-chars
N8N_ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaa
POSTGRES_PASSWORD=postgres-password-24chars
TAXTRONIK_APP_PASSWORD=app-password-24chars-long
TAXTRONIK_OWNER_PASSWORD=owner-password-24chars-x
TAXTRONIK_DRILL_PASSWORD=drill-password-24chars-x
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
    unset TAXTRONIK_OWNER_PASSWORD TAXTRONIK_DRILL_PASSWORD
    unset DATABASE_URL DATABASE_APP_URL NODE_ENV TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX TAXTRONIK_VERSION NEXTAUTH_URL
    unset NEXTAUTH_TRUST_HOST TRUST_PROXY_REQUIRED TRUST_PROXY_HOPS SIGNAL_DEPLOYMENT SIGNAL_DEPLOY_CHANNEL SIGNAL_IMAGE
    unset SIGNAL_GIT_URL SIGNAL_GIT_REF SIGNAL_GIT_DIR SIGNAL_BUILD_MEMORY_LIMIT SIGNAL_BUILD_MEMORY_RESERVE SIGNAL_BUILD_CPUS SIGNAL_LLM_DIR
    unset DEPLOYMENT_METHOD TRAEFIK_ACME_EMAIL N8N_HOST N8N_WEBHOOK_URL N8N_PROXY_HOPS
    unset RISK_LAYER_URL RISK_LAYER_TOKEN RISK_LAYER_OPERATOR_TOKEN RISK_LAYER_FESTWISSEN_DIR RISK_LAYER_EMB_DEVICE RISK_LAYER_LLM_BACKEND RISK_LAYER_LLM_TIMEOUT SMTP_HOST SMTP_PORT
    unset SMTP_FROM PORTAL_PUBLIC_URL STAFF_COOKIE_DOMAIN PORTAL_COOKIE_DOMAIN
    unset POSTGRES_MAX_CONNECTIONS APP_DB_POOL_MAX APP_DB_OWNER_POOL_MAX WORKER_DB_POOL_MAX
    unset WORKER_DB_OWNER_POOL_MAX DATABASE_CONNECTION_LIMIT
    unset TAXTRONIK_SOURCE_ALLOWED_SIGNERS TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE
    # Hermetisch: ein auf dem Testrechner vorhandenes /etc/taxtronik zaehlt nicht.
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="${OPS_SIGNERS_DEFAULT:-$TMP_DIR/absent-default-allowed-signers}"
    ENVFILE="$env_file"
    # Unit-Test darf nicht vom zufällig vorhandenen lokalen Docker-Volume
    # beziehungsweise dessen echtem n8n-Key abhängen.
    _doctor_n8n_volume_key() { :; }
    # Ebenso nicht von lokal laufenden TaxTronik-Containern (S-01-Live-Abgleich).
    [[ "${DOCTOR_TEST_LIVE_DB:-0}" == "1" ]] || _doctor_db_roles_live() { :; }
    # Und nicht von lokal vorhandenen Images (B-05-Schemazeilen, eigene Tests).
    [[ "${DOCTOR_TEST_SCHEMA:-0}" == "1" ]] || \
      _doctor_app_env_schema() { _dr_row "INFO" "SCHEMA" "im Test nicht geprueft"; }
    doctor "${@:3}"
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

test_doctor_checks_db_pool_sum_against_max_connections() {
  local env_file="$TMP_DIR/db-pools.env" out="$TMP_DIR/doctor-db-pools.out"
  write_prod_env "$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected the default pool sizes"
  }
  assert_contains "$out" "OK       DB_POOLS               52 von max_connections 100"

  printf 'APP_DB_POOL_MAX=80\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted pools above max_connections"
  fi
  assert_contains "$out" "FEHLT    DB_POOLS               112 > max_connections 100"

  write_prod_env "$env_file"
  printf 'POSTGRES_MAX_CONNECTIONS=60\nDATABASE_CONNECTION_LIMIT=20\n' >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor blocked a pool sum below max_connections"
  }
  assert_contains "$out" "WARN     DB_POOLS               52 von max_connections 60 (>80 %"
  assert_contains "$out" "WARN     DATABASE_CONNECTION_LIMIT veraltet"

  write_prod_env "$env_file"
  printf 'WORKER_DB_OWNER_POOL_MAX=zehn\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted a non-numeric pool size"
  fi
  assert_contains "$out" "FEHLT    WORKER_DB_OWNER_POOL_MAX positive ganze Zahl erwartet"
  pass "doctor checks the DB pool sum against max_connections"
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

# S-03: Ohne Proxy-Vertrauen fehlt die Client-IP; das ist zulässig, aber
# Login-Limits greifen dann nur pro Konto/E-Mail.
test_doctor_warns_without_proxy_trust() {
  local env_file="$TMP_DIR/own-proxy-trust.env" out="$TMP_DIR/own-proxy-trust.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" TRUST_PROXY_REQUIRED false
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor hard-failed TRUST_PROXY_REQUIRED=false for an own reverse proxy"
  }
  assert_contains "$out" "WARN     TRUST_PROXY_REQUIRED"
  assert_contains "$out" "Login-Limits nur pro Konto/E-Mail"
  assert_not_contains "$out" "TRUST_PROXY_HOPS"
  pass "doctor warns without failing when proxy trust is disabled"
}

# B-05 (d): Regeln, die nur das App-Schema wiederholten, prueft doctor nicht
# mehr selbst (NEXTAUTH_TRUST_HOST exakt true, TRUST_PROXY_HOPS 1-9,
# Cookie-Domain-Regeln, Risk-Layer-Paar/-Laenge/-Verschiedenheit). Sie stehen
# als SCHEMA_*-Zeilen aus dem Ziel-Image in doctor und stoppen deploy/update
# vor Backup und Migration (Tests unten und in apps/worker env-check).
test_doctor_leaves_schema_only_rules_to_the_target_image() {
  local env_file="$TMP_DIR/schema-only.env" out="$TMP_DIR/schema-only.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" NEXTAUTH_TRUST_HOST false
  {
    printf 'TRUST_PROXY_HOPS=0\n'
    printf 'STAFF_COOKIE_DOMAIN=kanzlei.example.de\n'
    printf 'PORTAL_COOKIE_DOMAIN=kanzlei.example.de\n'
    printf 'RISK_LAYER_URL=http://risk-layer:8000\n'
    printf 'RISK_LAYER_OPERATOR_TOKEN=too-short\n'
  } >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor still duplicated an app-schema rule"
  }
  assert_not_contains "$out" "NEXTAUTH_TRUST_HOST"
  assert_not_contains "$out" "TRUST_PROXY_HOPS"
  assert_not_contains "$out" "COOKIE_DOMAINS"
  assert_not_contains "$out" "RISK_LAYER_TOKEN"
  assert_not_contains "$out" "(< 32)"
  assert_contains "$out" "OK       SIGNAL                 verwaltet (http://risk-layer:8000)"
  assert_contains "$out" "INFO     SCHEMA"
  pass "doctor leaves rules that only repeat the app schema to the target-image check"
}

# B4: Die vier App-Secrets mit 32-Zeichen-Pflicht sind unter 32 Zeichen FEHLT
# (die App startet damit nicht); doctor --fix rotiert nichts. Host-Secrets
# bleiben bei SCHWACH.
test_doctor_requires_32_char_app_secrets_without_rotation() {
  local env_file="$TMP_DIR/short-secrets.env" out="$TMP_DIR/short-secrets.out" key
  write_prod_env "$env_file"
  set_env_file_value "$env_file" AUTH_SECRET short-auth-secret-value
  set_env_file_value "$env_file" SECRET_BOX_KEY short-box-key-value
  set_env_file_value "$env_file" S3_SECRET_KEY short-s3-secret-value
  set_env_file_value "$env_file" N8N_HMAC_SECRET short-hmac-secret-value
  set_env_file_value "$env_file" POSTGRES_PASSWORD short-postgres
  cp "$env_file" "$env_file.before"
  if run_doctor_with_env "$env_file" "$out" --fix; then
    test_fail "doctor accepted app secrets below 32 characters"
  fi
  for key in AUTH_SECRET SECRET_BOX_KEY S3_SECRET_KEY N8N_HMAC_SECRET; do
    assert_contains "$out" "FEHLT    $key"
    assert_key_equals "$env_file" "$key" "$(grep -E "^${key}=" "$env_file.before" | cut -d= -f2-)"
  done
  assert_contains "$out" "App startet so nicht; kontrolliert rotieren (docs/operations/secret-rotation.md), --fix rotiert nicht"
  assert_contains "$out" "SCHWACH  POSTGRES_PASSWORD      nur 14 Zeichen (< 24)"
  assert_key_equals "$env_file" POSTGRES_PASSWORD short-postgres
  pass "doctor fails app secrets below 32 characters and never rotates them automatically"
}

# B4: N8N_HMAC_SECRET nur bei Bedarf Pflicht (wie das App-Schema).
test_doctor_requires_n8n_hmac_secret_only_when_needed() {
  local env_file="$TMP_DIR/hmac-need.env" out="$TMP_DIR/hmac-need.out"
  write_prod_env "$env_file"
  sed -i -E '/^N8N_HMAC_SECRET=/d' "$env_file"
  run_doctor_with_env "$env_file" "$out" || { cat "$out" >&2; test_fail "doctor required an unused N8N_HMAC_SECRET"; }
  assert_contains "$out" "OK       N8N_HMAC_SECRET        nicht benoetigt"

  printf 'N8N_LEGACY_CALLBACKS_ENABLED=true\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted legacy callbacks without N8N_HMAC_SECRET"
  fi
  assert_contains "$out" "FEHLT    N8N_HMAC_SECRET        leer -> './taxtronik doctor --fix'"

  set_env_file_value "$env_file" N8N_LEGACY_CALLBACKS_ENABLED false
  printf 'N8N_WEBHOOK_BASE_URL=https://n8n.example.de/webhook\n' >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted a webhook base without N8N_HMAC_SECRET"
  fi
  assert_contains "$out" "FEHLT    N8N_HMAC_SECRET"

  (
    POSTGRES_PASSWORD=x TAXTRONIK_APP_PASSWORD=x AUTH_SECRET=x S3_ENDPOINT=x S3_ACCESS_KEY=x
    S3_SECRET_KEY=x N8N_ENCRYPTION_KEY=x N8N_DB_PASSWORD=x
    unset N8N_HMAC_SECRET
    require_cmd() { :; }
    preflight_common
  ) >"$out" 2>&1 || { cat "$out" >&2; test_fail "preflight still requires N8N_HMAC_SECRET"; }
  pass "doctor and preflight require N8N_HMAC_SECRET only for legacy callbacks or a webhook base"
}

# B4: HTTPS fuer NEXTAUTH_URL und PORTAL_PUBLIC_URL in Produktion.
test_doctor_requires_https_public_urls() {
  local env_file="$TMP_DIR/https-urls.env" out="$TMP_DIR/https-urls.out"
  write_prod_env "$env_file"
  run_doctor_with_env "$env_file" "$out" || { cat "$out" >&2; test_fail "doctor rejected HTTPS URLs"; }
  assert_contains "$out" "OK       NEXTAUTH_URL           https://kanzlei.example.de"
  assert_contains "$out" "OK       PORTAL_PUBLIC_URL      https://mandanten.example.de"

  set_env_file_value "$env_file" NEXTAUTH_URL http://kanzlei.example.de
  set_env_file_value "$env_file" PORTAL_PUBLIC_URL http://mandanten.example.de
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted HTTP public URLs in production"
  fi
  assert_contains "$out" "FEHLT    NEXTAUTH_URL           =http://kanzlei.example.de: in Produktion ist HTTPS Pflicht"
  assert_contains "$out" "FEHLT    PORTAL_PUBLIC_URL      =http://mandanten.example.de: in Produktion ist HTTPS Pflicht"

  write_prod_env "$env_file"
  sed -i -E '/^NEXTAUTH_URL=/d' "$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted an empty NEXTAUTH_URL (Compose falls back to http://localhost:3000)"
  fi
  assert_contains "$out" "FEHLT    NEXTAUTH_URL           leer: Compose setzt http://localhost:3000"

  write_prod_env "$env_file"
  set_env_file_value "$env_file" NEXTAUTH_URL https://localhost:3000
  sed -i -E '/^PORTAL_PUBLIC_URL=/d' "$env_file"
  run_doctor_with_env "$env_file" "$out" || { cat "$out" >&2; test_fail "HTTPS localhost was rejected"; }
  assert_contains "$out" "WARN     NEXTAUTH_URL           =https://localhost:3000 (oeffentliche URL setzen)"
  assert_contains "$out" "WARN     PORTAL_PUBLIC_URL      leer (Single-Host: ok)"
  pass "doctor requires HTTPS for NEXTAUTH_URL and a set PORTAL_PUBLIC_URL in production"
}

# B4: Einseitige Cookie-Domains sind eine Warnung (wie im App-Schema), auch in
# der interaktiven .env-Vorbereitung; die uebrigen Cookie-Regeln bleiben hart.
test_one_sided_cookie_domains_only_warn() {
  local env_file="$TMP_DIR/one-sided-cookie.env" out="$TMP_DIR/one-sided-cookie.out"
  printf 'STAFF_COOKIE_DOMAIN=kanzlei.example.de\nPORTAL_COOKIE_DOMAIN=\nPORTAL_PUBLIC_URL=https://mandanten.example.de\n' \
    >"$env_file"
  ( ENVFILE="$env_file"; validate_cookie_domains_or_die ) >"$out" 2>&1 || {
    cat "$out" >&2
    test_fail "one-sided cookie domains still stopped the env preparation"
  }
  assert_contains "$out" "nur einseitig gesetzt"
  set_env_file_value "$env_file" PORTAL_COOKIE_DOMAIN kanzlei.example.de
  if ( ENVFILE="$env_file"; validate_cookie_domains_or_die ) >"$out" 2>&1; then
    test_fail "identical cookie domains were accepted"
  fi
  assert_contains "$out" "unterschiedliche Subdomains"
  pass "one-sided cookie domains only warn while the other cookie rules still stop"
}

# B-05 (c): doctor zeigt die Befunde der Konfigurationspruefung, wenn das
# konfigurierte Worker-Image lokal vorliegt; sonst und im internen Gate von
# deploy/update eine INFO-Zeile.
test_doctor_shows_target_image_schema_rows() {
  local env_file="$TMP_DIR/schema-rows.env" out="$TMP_DIR/schema-rows.out" calls="$TMP_DIR/schema-rows.calls"
  write_prod_env "$env_file"
  schema_doctor() (
    docker() {
      printf 'docker %s\n' "$*" >>"$calls"
      [[ "$1 $2" == "image inspect" && "${SCHEMA_IMAGE:-present}" == present ]]
    }
    run_app_env_check() {
      printf 'run_app_env_check\n' >>"$calls"
      printf '%s' "${SCHEMA_OUTPUT:-}"
      return "${SCHEMA_STATUS:-0}"
    }
    DOCTOR_TEST_SCHEMA=1 run_doctor_with_env "$env_file" "$out"
  )

  : >"$calls"
  SCHEMA_STATUS=1 SCHEMA_OUTPUT="$(printf '%s\n' \
    '  FEHLT    SCHEMA_WEB             [config] NEXTAUTH_TRUST_HOST muss in Produktion explizit `true` sein.' \
    '  WARN     SCHEMA_WEB             [config] WARNUNG: STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN nicht gesetzt' \
    '  OK       SCHEMA_WORKER          Schema und Pruefungen der App bestanden')" schema_doctor && \
    test_fail "doctor accepted a schema error of the target image"
  assert_contains "$calls" "docker image inspect registry.example/taxtronik/worker:1.2.3"
  assert_contains "$calls" "run_app_env_check"
  assert_contains "$out" "FEHLT    SCHEMA_WEB             [config] NEXTAUTH_TRUST_HOST muss in Produktion explizit"
  assert_contains "$out" "WARN     SCHEMA_WEB             [config] WARNUNG: STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN"
  assert_contains "$out" "OK       SCHEMA_WORKER          Schema und Pruefungen der App bestanden"
  assert_contains "$out" "1 Fehler"

  : >"$calls"
  SCHEMA_OUTPUT="$(printf '%s\n' \
    '  OK       SCHEMA_WEB             Schema und Pruefungen der App bestanden' \
    '  OK       SCHEMA_WORKER          Schema und Pruefungen der App bestanden')" schema_doctor || {
    cat "$out" >&2
    test_fail "doctor rejected a clean target-image schema check"
  }
  assert_contains "$out" "OK       SCHEMA_WEB"

  # Pruefung lief nicht (z. B. Compose-Interpolation): FEHLT statt still OK.
  : >"$calls"
  SCHEMA_STATUS=1 SCHEMA_OUTPUT='required variable NEXTAUTH_TRUST_HOST is missing a value' schema_doctor && \
    test_fail "doctor accepted a schema check that did not run"
  assert_contains "$out" "           required variable NEXTAUTH_TRUST_HOST is missing a value"
  assert_contains "$out" "FEHLT    SCHEMA                 Pruefung im Image registry.example/taxtronik/worker:1.2.3 nicht ausfuehrbar (Exit 1"

  : >"$calls"
  SCHEMA_IMAGE=absent schema_doctor || { cat "$out" >&2; test_fail "missing image blocked doctor"; }
  assert_contains "$out" "INFO     SCHEMA                 registry.example/taxtronik/worker:1.2.3 nicht lokal; deploy/update pruefen"
  assert_not_contains "$calls" "run_app_env_check"

  : >"$calls"
  _TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1 schema_doctor || { cat "$out" >&2; test_fail "config-only doctor failed"; }
  assert_contains "$out" "INFO     SCHEMA                 deploy/update pruefen die App-Konfiguration im Ziel-Image"
  assert_not_exists_or_empty "$calls"
  pass "doctor shows the target image's schema rows when the configured worker image is local"
}

# B-05 (b): run_app_env_check startet die Konfigurationspruefung ueber den
# Compose-Wrapper im konfigurierten Worker-Image, das Web-Profil mit der ENV des
# app-Dienstes (Override), ohne Abhaengigkeiten.
test_app_env_check_runs_in_the_target_worker_image() {
  local calls="$TMP_DIR/env-check-compose.calls" out="$TMP_DIR/env-check-compose.out"
  local worker_image override_image
  : >"$calls"
  (
    deployment_method() { printf 'standard'; }
    render_s3_config() { :; }
    ensure_compose_image_pinning() { :; }
    docker() { printf '%s\n' "$*" >>"$calls"; return "${ENV_CHECK_EXIT:-0}"; }
    run_app_env_check
  ) >"$out" 2>&1 || test_fail "env check failed with passing containers"
  assert_contains "$calls" "compose -f $BASE -f $APP -f $ENV_CHECK_COMPOSE --env-file $ENVFILE run --rm --no-deps -T app node dist/env-check.js --profile web"
  assert_contains "$calls" "run --rm --no-deps -T worker node dist/env-check.js --profile worker"

  if (
    deployment_method() { printf 'standard'; }
    render_s3_config() { :; }
    ensure_compose_image_pinning() { :; }
    docker() { [[ "$*" == *"--profile web"* ]] && return 1; return 0; }
    run_app_env_check
  ) >"$out" 2>&1; then
    test_fail "a failing web profile check was ignored"
  fi

  # Verwaltetes Traefik: Die Pruefung laedt weder das Traefik-File noch
  # schreibt sie dessen dynamische Route neu (doctor aendert kein Routing).
  : >"$calls"
  (
    deployment_method() { printf 'traefik'; }
    render_s3_config() { :; }
    ensure_compose_image_pinning() { :; }
    render_traefik_dynamic_config() { test_fail "env check re-rendered the live Traefik routes"; }
    docker() { printf '%s\n' "$*" >>"$calls"; }
    run_app_env_check
  ) >"$out" 2>&1 || { cat "$out" >&2; test_fail "env check failed on the Traefik path"; }
  assert_not_contains "$calls" "$TRAEFIK"
  assert_contains "$calls" "-f $ENV_CHECK_COMPOSE"

  # Das Override muss genau das Worker-Image des Ziel-Releases verwenden.
  worker_image="$(sed -n '/^  worker:/,/^  [a-z]/s/^    image: //p' "$APP" | tr -d '\r' | head -n1)"
  override_image="$(sed -n 's/^    image: //p' "$ENV_CHECK_COMPOSE" | tr -d '\r')"
  [[ -n "$worker_image" && "$override_image" == "$worker_image" ]] || \
    test_fail "env-check override image '$override_image' differs from the worker image '$worker_image'"
  pass "the app env check runs both profiles in the configured worker image without dependencies"
}

# B-05 (b): Reihenfolge im Deploy (gefaelschtes compose): nach provide_images,
# vor Pflichtbackup und Migration; ein Schemafehler stoppt davor.
test_deploy_checks_app_env_schema_before_backup_and_migration() {
  local steps="$TMP_DIR/env-check-deploy.steps" out="$TMP_DIR/env-check-deploy.out"
  run_core_deploy() (
    NODE_ENV=production TAXTRONIK_DEPLOY_CHANNEL=release
    load_env() { :; }
    preflight_common() { :; }
    assert_production_env() { :; }
    require_release_version() { :; }
    assert_no_database_restore_pending() { :; }
    ensure_host_tool_deps() { :; }
    prepare_release_contract() { :; }
    start_infra() { printf 'start-infra\n' >>"$steps"; }
    wait_postgres_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    provide_images() { printf 'provide-images\n' >>"$steps"; }
    compose() {
      printf 'compose %s\n' "$*" >>"$steps"
      [[ "$*" == *"--profile ${ENV_CHECK_FAIL:-none}"* ]] && return 1
      return 0
    }
    provide_traefik_for_deploy() { printf 'provide-traefik\n' >>"$steps"; }
    provide_signal_for_deploy() { printf 'provide-signal\n' >>"$steps"; }
    backup_before_migrations() { printf 'backup\n' >>"$steps"; }
    run_migrations() { printf 'migrate\n' >>"$steps"; }
    ensure_provisioned_interactive() { :; }
    ensure_managed_n8n_connection() { :; }
    start_signal_for_deploy() { :; }
    start_apps_for_activation() { printf 'start-apps\n' >>"$steps"; }
    smoke_health() { :; }
    smoke_public_frontend() { :; }
    smoke_client_ip() { :; }
    deploy_readiness() { :; }
    finalize_release_contract() { printf 'finalize\n' >>"$steps"; }
    _deploy_core
  )
  : >"$steps"
  run_core_deploy >"$out" 2>&1 || { cat "$out" >&2; test_fail "deploy failed with a valid schema check"; }
  assert_before "$steps" "provide-images" "compose run --rm --no-deps -T app node dist/env-check.js --profile web"
  assert_before "$steps" "compose run --rm --no-deps -T worker node dist/env-check.js --profile worker" "provide-signal"
  assert_before "$steps" "node dist/env-check.js --profile worker" "backup"
  assert_before "$steps" "backup" "migrate"

  : >"$steps"
  if ENV_CHECK_FAIL=worker run_core_deploy >"$out" 2>&1; then
    test_fail "deploy continued after a schema error of the target image"
  fi
  assert_contains "$out" "Konfiguration verletzt das Schema des Ziel-Images"
  assert_contains "$out" "vor Backup und Migration abgebrochen"
  assert_not_contains "$steps" "backup"
  assert_not_contains "$steps" "migrate"
  assert_not_contains "$steps" "start-apps"
  pass "deploy checks the app env schema in the target image after provide_images and before backup and migration"
}

# B-05-Nacharbeit: Ein Lesefehler der .env sieht nie wie "nicht gesetzt" aus.
# Frueher lieferte get_env dann still einen leeren Wert; ensure_secret erzeugte
# daraufhin ein neues Secret, und set_env haengte ein Duplikat an.
test_env_read_errors_never_look_like_missing_values() {
  local env_file="$TMP_DIR/env-read-error.env" out="$TMP_DIR/env-read-error.out" rc value
  printf 'AUTH_SECRET=existing-secret-value-with-32-chars-x\nN8N_DB_PASSWORD=\n' >"$env_file"
  cp "$env_file" "$env_file.before"
  failing_reads() {
    ENVFILE="$env_file"
    grep() {
      if [[ "${!#}" == "$ENVFILE" ]]; then
        printf 'grep: %s: Eingabe-/Ausgabefehler\n' "$ENVFILE" >&2
        return 2
      fi
      command grep "$@"
    }
  }

  rc=0
  value="$(failing_reads; get_env AUTH_SECRET 2>"$out")" || rc=$?
  [[ "$rc" == "2" && -z "$value" ]] || test_fail "get_env masked a read error (rc=$rc, value='$value')"
  assert_contains "$out" "konnte nicht gelesen werden (grep-Exit 2); Wert von AUTH_SECRET unbekannt"

  if ( failing_reads; ensure_secret N8N_DB_PASSWORD 24 ) >"$out" 2>&1; then
    test_fail "ensure_secret generated a secret although .env was unreadable"
  fi
  assert_contains "$out" "N8N_DB_PASSWORD ist in $env_file nicht lesbar; es wird kein neues Secret erzeugt."
  if ( failing_reads; set_env AUTH_SECRET replaced-value ) >"$out" 2>&1; then
    test_fail "set_env wrote although .env was unreadable"
  fi
  assert_contains "$out" "konnte nicht gelesen werden (grep-Exit 2); AUTH_SECRET wird nicht geschrieben."
  cmp -s "$env_file" "$env_file.before" || test_fail "a read error changed .env"

  # Normalfall unveraendert: Wert, fehlender Schluessel (leer, rc 0), Anfuegen.
  [[ "$(ENVFILE="$env_file" get_env AUTH_SECRET)" == "existing-secret-value-with-32-chars-x" ]] || \
    test_fail "get_env no longer reads values"
  value="$(ENVFILE="$env_file" get_env MISSING_KEY)" || test_fail "a missing key failed get_env"
  [[ -z "$value" ]] || test_fail "a missing key returned a value"
  ( ENVFILE="$env_file"; ensure_secret N8N_DB_PASSWORD 24 ) >/dev/null || test_fail "ensure_secret failed on a readable .env"
  [[ "$(grep -c '^N8N_DB_PASSWORD=' "$env_file")" == "1" ]] || test_fail "ensure_secret duplicated a key"
  pass "a .env read error is reported and never regenerates or duplicates a secret"
}

# B-05-Nacharbeit: Ohne gueltigen HEAD bleibt TAXTRONIK_VERSION in .env
# unveraendert. Frueher schrieben doctor --fix und prepare_env_interactive den
# leeren Wert eines gescheiterten source_version_for_checkout.
test_source_version_is_never_written_empty() {
  local env_file="$TMP_DIR/source-version-empty.env" out="$TMP_DIR/source-version-empty.out"
  local no_git="$TMP_DIR/source-version-no-git"
  mkdir -p "$no_git"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" NODE_ENV development
  set_env_file_value "$env_file" TAXTRONIK_DEPLOY_CHANNEL source
  set_env_file_value "$env_file" TAXTRONIK_IMAGE_PREFIX taxtronik
  set_env_file_value "$env_file" TAXTRONIK_VERSION source-deadbeef1234

  if ( ROOT="$no_git"; export GIT_CEILING_DIRECTORIES="$TMP_DIR"; run_doctor_with_env "$env_file" "$out" --fix ); then
    test_fail "doctor --fix succeeded without a valid HEAD"
  fi
  assert_contains "$out" "Source-Kennung nicht bestimmbar; TAXTRONIK_VERSION in $env_file bleibt unveraendert."
  assert_key_equals "$env_file" TAXTRONIK_VERSION source-deadbeef1234

  if (
    ROOT="$no_git"
    ENVFILE="$env_file"
    export GIT_CEILING_DIRECTORIES="$TMP_DIR"
    unset TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX
    doctor() { test_fail "env preparation continued after a failed source version"; }
    prepare_env_interactive
  ) </dev/null >"$out" 2>&1; then
    test_fail "env preparation succeeded without a valid HEAD"
  fi
  assert_contains "$out" "Source-Kennung nicht bestimmbar"
  assert_key_equals "$env_file" TAXTRONIK_VERSION source-deadbeef1234
  pass "a failed source version never overwrites TAXTRONIK_VERSION with an empty value"
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

# S-01: Owner-Verbindung von app/worker und Restore-Drill-Rolle.
test_doctor_fix_provisions_db_role_secrets() {
  local env_file="$TMP_DIR/db-role-secrets.env" out="$TMP_DIR/db-role-secrets.out"
  local owner drill
  write_prod_env "$env_file"
  sed -i -E '/^TAXTRONIK_(OWNER|DRILL)_PASSWORD=/d' "$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted missing DB role secrets"
  fi
  assert_contains "$out" "FEHLT    TAXTRONIK_OWNER_PASSWORD leer -> './taxtronik doctor --fix'"
  assert_contains "$out" "FEHLT    TAXTRONIK_DRILL_PASSWORD leer -> './taxtronik doctor --fix'"

  run_doctor_with_env "$env_file" "$out" --fix || {
    cat "$out" >&2
    test_fail "doctor --fix did not provision the DB role secrets"
  }
  owner="$(grep -E '^TAXTRONIK_OWNER_PASSWORD=' "$env_file" | cut -d= -f2-)"
  drill="$(grep -E '^TAXTRONIK_DRILL_PASSWORD=' "$env_file" | cut -d= -f2-)"
  [[ "$owner" =~ ^[A-Za-z0-9_-]{32}$ && "$drill" =~ ^[A-Za-z0-9_-]{32}$ && "$owner" != "$drill" ]] || \
    test_fail "doctor --fix did not generate distinct base64url DB role secrets"
  assert_contains "$out" "OK       DB_ROLE_SECRETS        Superuser, App, Owner und Drill getrennt"

  # Bestehende Werte bleiben unverändert (dieselbe Rolle hat sie bereits).
  run_doctor_with_env "$env_file" "$out" --fix || test_fail "repeated doctor --fix failed"
  assert_key_equals "$env_file" TAXTRONIK_OWNER_PASSWORD "$owner"
  assert_key_equals "$env_file" TAXTRONIK_DRILL_PASSWORD "$drill"
  pass "doctor --fix provisions owner and drill role secrets once"
}

test_doctor_requires_distinct_db_role_secrets() {
  local env_file="$TMP_DIR/db-role-reuse.env" out="$TMP_DIR/db-role-reuse.out"
  write_prod_env "$env_file"
  set_env_file_value "$env_file" TAXTRONIK_OWNER_PASSWORD postgres-password-24chars
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted the superuser password for the container owner role"
  fi
  assert_contains "$out" "FEHLT    DB_ROLE_SECRETS        Owner-/Drill-Passwort muss sich"
  pass "doctor rejects a container role password equal to the superuser password"
}

test_doctor_rejects_superuser_in_container_db_urls() {
  local env_file="$TMP_DIR/db-role-urls.env" out="$TMP_DIR/db-role-urls.out"
  local app_copy="$TMP_DIR/superuser-app.yml"
  write_prod_env "$env_file"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected the shipped compose role contract"
  }
  assert_contains "$out" "OK       DB_ROLE_APP            DATABASE_URL als taxtronik_owner (kein Superuser)"
  assert_contains "$out" "OK       DB_ROLE_WORKER         DATABASE_URL als taxtronik_owner (kein Superuser)"
  assert_contains "$out" "OK       DB_ROLE_DRILL          Restore-Drill als taxtronik_drill"
  # Migrationen behalten den Superuser.
  [[ "$(compose_service_db_user "$APP" migrate DATABASE_URL)" == "taxtronik" ]] || \
    test_fail "migrate must keep the superuser connection"

  sed -E 's|postgresql://taxtronik_owner:\$\{TAXTRONIK_OWNER_PASSWORD[^}]*\}|postgresql://taxtronik:${POSTGRES_PASSWORD}|' \
    "$APP" >"$app_copy"
  if (APP="$app_copy" run_doctor_with_env "$env_file" "$out"); then
    test_fail "doctor accepted the superuser in the app/worker DATABASE_URL"
  fi
  assert_contains "$out" "FEHLT    DB_ROLE_APP            DATABASE_URL nutzt den Superuser taxtronik statt taxtronik_owner"
  assert_contains "$out" "FEHLT    DB_ROLE_WORKER         DATABASE_URL nutzt den Superuser taxtronik statt taxtronik_owner"
  pass "doctor rejects the superuser in the app/worker DATABASE_URL"
}

test_doctor_reports_live_db_role_state() {
  local env_file="$TMP_DIR/db-role-live.env" out="$TMP_DIR/db-role-live.out"
  write_prod_env "$env_file"
  live_docker() {
    case "$1 ${2:-} ${3:-}" in
      'inspect --format {{.State.Running}}') printf 'true\n' ;;
      'inspect --format {{range .Config.Env}}{{println .}}{{end}}')
        if [[ "$4" == taxtronik-app ]]; then
          printf 'NODE_ENV=production\nDATABASE_URL=postgresql://taxtronik:secret@postgres:5432/taxtronik\n'
        else
          printf 'DATABASE_URL=postgresql://taxtronik_owner:secret@postgres:5432/taxtronik\n'
        fi
        ;;
      'exec -i taxtronik-postgres')
        cat >/dev/null
        # Drill-Rolle fehlt, Owner-Rolle wie vorgesehen.
        printf 'taxtronik_owner t f f f f t f t\n'
        ;;
      *) return 1 ;;
    esac
  }
  if (docker() { live_docker "$@"; }; DOCTOR_TEST_LIVE_DB=1 run_doctor_with_env "$env_file" "$out"); then
    test_fail "doctor accepted a missing drill role and a superuser app container"
  fi
  assert_contains "$out" "OK       DB_ROLE_LIVE_owner     taxtronik_owner wie vorgesehen (kein Superuser)"
  assert_contains "$out" "FEHLT    DB_ROLE_LIVE_drill     Rolle taxtronik_drill fehlt in Postgres"
  assert_contains "$out" "FEHLT    DB_ROLE_RUN_app        laeuft als 'taxtronik' statt taxtronik_owner"
  assert_contains "$out" "OK       DB_ROLE_RUN_worker     laeuft als taxtronik_owner"
  assert_not_contains "$out" "secret"

  # Fehlkonfiguration (Superuser-Attribut) wird benannt.
  live_docker() {
    case "$1 ${2:-} ${3:-}" in
      'inspect --format {{.State.Running}}') [[ "$4" == taxtronik-postgres ]] && printf 'true\n' ;;
      'exec -i taxtronik-postgres')
        cat >/dev/null
        printf 'taxtronik_owner t t f f f t f t\ntaxtronik_drill t f t f f t f t\n'
        ;;
      *) return 1 ;;
    esac
  }
  if (docker() { live_docker "$@"; }; DOCTOR_TEST_LIVE_DB=1 run_doctor_with_env "$env_file" "$out"); then
    test_fail "doctor accepted a superuser owner role"
  fi
  assert_contains "$out" "FEHLT    DB_ROLE_LIVE_owner     taxtronik_owner falsch konfiguriert (login/super/createdb/createrole/replication/bypassrls/member/grants=t/t/f/f/f/t/f/t, erwartet t/f/f/f/f/t/f/t)"
  assert_contains "$out" "OK       DB_ROLE_LIVE_drill     taxtronik_drill wie vorgesehen (kein Superuser)"

  # Rolle synchronisiert, Migration aber noch nicht angewendet.
  live_docker() {
    case "$1 ${2:-} ${3:-}" in
      'inspect --format {{.State.Running}}') [[ "$4" == taxtronik-postgres ]] && printf 'true\n' ;;
      'exec -i taxtronik-postgres')
        cat >/dev/null
        printf 'taxtronik_owner t f f f f t f f\ntaxtronik_drill t f t f f t f t\n'
        ;;
      *) return 1 ;;
    esac
  }
  if (docker() { live_docker "$@"; }; DOCTOR_TEST_LIVE_DB=1 run_doctor_with_env "$env_file" "$out"); then
    test_fail "doctor accepted an owner role without the migration grants"
  fi
  assert_contains "$out" "FEHLT    DB_ROLE_LIVE_owner     taxtronik_owner ohne Grants: Migration 20261006160000_owner_role_least_privilege fehlt"

  # Das Konfigurations-Gate von deploy/update prüft keinen Live-Zustand: Rollen
  # synchronisiert der Ablauf erst danach, alte Container ersetzt die Aktivierung.
  (
    docker() { live_docker "$@"; }
    _TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1
    DOCTOR_TEST_LIVE_DB=1 run_doctor_with_env "$env_file" "$out"
  ) || {
    cat "$out" >&2
    test_fail "config-only doctor gate evaluated the live DB role state"
  }
  assert_not_contains "$out" "DB_ROLE_LIVE_"
  pass "doctor reports live DB role and container state outside the deploy gate"
}

test_sync_postgres_roles_provisions_owner_and_drill_roles() {
  local sql="$TMP_DIR/sync-roles.sql" args="$TMP_DIR/sync-roles.args" out="$TMP_DIR/sync-roles.out"
  (
    docker() { printf '%s\n' "$*" >"$args"; cat >"$sql"; }
    POSTGRES_PASSWORD=super-pw-value TAXTRONIK_APP_PASSWORD=app-pw-value
    TAXTRONIK_OWNER_PASSWORD="own'er-pw-value" TAXTRONIK_DRILL_PASSWORD=drill-pw-value
    N8N_DB_PASSWORD=n8n-pw-value
    sync_postgres_roles_from_env
  ) >"$out" 2>&1 || {
    cat "$out" >&2
    test_fail "sync_postgres_roles_from_env failed"
  }
  assert_contains "$sql" "ALTER ROLE taxtronik WITH PASSWORD 'super-pw-value';"
  assert_contains "$sql" "ALTER ROLE taxtronik_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'app-pw-value')"
  assert_contains "$sql" "CREATE ROLE taxtronik_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', 'app-pw-value')"
  assert_contains "$sql" "ALTER ROLE taxtronik_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', 'own''er-pw-value')"
  assert_contains "$sql" "CREATE ROLE taxtronik_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', 'own''er-pw-value')"
  assert_contains "$sql" "ALTER ROLE taxtronik_drill WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', 'drill-pw-value')"
  assert_contains "$sql" "CREATE ROLE taxtronik_drill LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', 'drill-pw-value')"
  assert_file_equals "$args" "exec -i taxtronik-postgres psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1"

  # Ohne neues Secret (Altinstallation ohne doctor --fix) bricht die
  # Synchronisierung ab, bevor docker aufgerufen wird.
  if (
    docker() { test_fail "sync must not reach docker without the owner secret"; }
    POSTGRES_PASSWORD=super-pw-value TAXTRONIK_APP_PASSWORD=app-pw-value
    unset TAXTRONIK_OWNER_PASSWORD
    TAXTRONIK_DRILL_PASSWORD=drill-pw-value N8N_DB_PASSWORD=n8n-pw-value
    sync_postgres_roles_from_env
  ) >"$out" 2>&1; then
    test_fail "sync accepted a missing TAXTRONIK_OWNER_PASSWORD"
  fi
  assert_contains "$out" "Pflichtwerte fehlen in .env: TAXTRONIK_OWNER_PASSWORD"
  pass "role sync provisions owner and drill roles with fixed attributes"
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
  assert_key_equals "$env_file" UPDATE_MANIFEST_URL \
    https://git.hirschmann-koxha.de/TaxTronik/updates/raw/branch/main/manifest.json
  assert_key_equals "$env_file" UPDATE_PUBLIC_KEY \
    NE1YtBNNPFM545o1VqoBNTcKIPmZP0rmvLq22YyqKaU=
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

# B3: Das Initialsetup fragt beim Standardweg, ob der Reverse-Proxy
# X-Forwarded-For setzt und wie viele Hops anhaengen; das verwaltete Traefik
# setzt true/1 ohne Frage. Ohne TTY oder mit bestehender .env fragt nichts.
test_setup_asks_for_client_ip_trust() {
  local out="$TMP_DIR/setup-proxy-trust.out" env_file="$TMP_DIR/setup-proxy-trust.env"
  local plan_root="$TMP_DIR/setup-proxy-trust-root"
  mkdir -p "$plan_root"
  : >"$plan_root/.env.example"
  setup_trust() (
    _SETUP_METHOD="$1"
    configure_setup_client_ip_trust >>"$out" 2>&1
    printf '%s/%s\n' "$_SETUP_TRUST_PROXY_REQUIRED" "$_SETUP_TRUST_PROXY_HOPS"
  )
  : >"$out"
  [[ "$(setup_trust standard <<<'')" == "false/1" ]] || test_fail "Enter did not keep the safe default"
  [[ "$(setup_trust standard <<<'n')" == "false/1" ]] || test_fail "'n' enabled proxy trust"
  [[ "$(setup_trust standard <<<$'j\n')" == "true/1" ]] || test_fail "'j' + Enter did not give one hop"
  [[ "$(setup_trust standard <<<$'ja\n2')" == "true/2" ]] || test_fail "two proxy hops were not taken"
  [[ "$(setup_trust standard <<<$'Y\n0\n12\n3')" == "true/3" ]] || test_fail "invalid hop counts were accepted"
  assert_contains "$out" "Bitte eine ganze Zahl von 1 bis 9 angeben."
  [[ "$(setup_trust traefik </dev/null)" == "true/1" ]] || test_fail "managed Traefik did not trust its own hop"
  if ( _SETUP_METHOD=standard; configure_setup_client_ip_trust <<<'j' ) >/dev/null 2>"$out"; then
    test_fail "setup continued without a hop answer"
  fi
  assert_contains "$out" "Initialsetup ohne Angabe der Proxy-Hops abgebrochen."

  apply_trust_plan() (
    ROOT="$plan_root"
    ENVFILE="$env_file"
    INSTALL_PENDING="$plan_root/install.pending"
    rm -f -- "$env_file"
    _SETUP_METHOD="$1" _SETUP_TRUST_PROXY_REQUIRED="$2" _SETUP_TRUST_PROXY_HOPS="$3"
    _SETUP_DEPLOY_CHANNEL="release" _SETUP_IMAGE_PREFIX="registry.example/taxtronik"
    _SETUP_RELEASE_VERSION="1.2.3" _SETUP_STAFF_HOST="staff.example.de"
    _SETUP_PORTAL_HOST="portal.example.de" _SETUP_N8N_HOST="n8n.example.de"
    _SETUP_ACME_EMAIL="admin@example.de" _SETUP_SMTP_HOST="smtp.example.de" _SETUP_SMTP_PORT="587"
    _SETUP_SMTP_FROM="noreply@example.de" _SETUP_SMTP_USER="" _SETUP_SMTP_PASSWORD=""
    _SETUP_SIGNAL_MODE="disabled" _SETUP_SIGNAL_CHANNEL="" _SETUP_SIGNAL_IMAGE=""
    _SETUP_SIGNAL_GIT_URL="" _SETUP_SIGNAL_GIT_REF="" _SETUP_SIGNAL_GIT_DIR=""
    _SETUP_SIGNAL_URL="" _SETUP_SIGNAL_TOKEN="" _SETUP_SIGNAL_OPERATOR_TOKEN=""
    _SETUP_TENANT_NAME="Testkanzlei" _SETUP_ADMIN_EMAIL="admin@example.de"
    apply_initial_setup_plan
  )
  apply_trust_plan standard true 2
  assert_key_equals "$env_file" TRUST_PROXY_REQUIRED true
  assert_key_equals "$env_file" TRUST_PROXY_HOPS 2
  apply_trust_plan standard false 1
  assert_key_equals "$env_file" TRUST_PROXY_REQUIRED false
  assert_key_equals "$env_file" TRUST_PROXY_HOPS 1
  apply_trust_plan traefik false 3
  assert_key_equals "$env_file" TRUST_PROXY_REQUIRED true
  assert_key_equals "$env_file" TRUST_PROXY_HOPS 1

  # Nicht interaktiv oder mit bestehender .env: keine Frage, keine Aenderung.
  printf 'TRUST_PROXY_REQUIRED=false\nTRUST_PROXY_HOPS=1\n' >"$env_file"
  (
    ENVFILE="$env_file"
    configure_setup_client_ip_trust() { test_fail "existing installation was asked again"; }
    configure_initial_deployment_interactive
  ) </dev/null >"$out" 2>&1 || test_fail "non-interactive setup failed"
  assert_file_equals "$env_file" $'TRUST_PROXY_REQUIRED=false\nTRUST_PROXY_HOPS=1'
  pass "setup asks for X-Forwarded-For trust and proxy hops on the standard path only"
}

# B3: Urteile des Client-IP-Smokes mit gefaelschten Antworten der Route und
# gefaelschten Docker-Netzadressen.
run_client_ip_smoke() (
  NEXTAUTH_URL="https://kanzlei.example.de/"
  TRUST_PROXY_REQUIRED="${SMOKE_TRUST:-true}"
  TRUST_PROXY_HOPS=1
  DEPLOYMENT_METHOD="${SMOKE_METHOD:-standard}"
  sleep() { :; }
  curl() {
    printf 'curl %s\n' "$*" >>"$SMOKE_CALLS"
    if [[ "$SMOKE_BODY" == FAIL ]]; then
      printf 'curl: (7) Failed to connect to kanzlei.example.de port 443\n' >&2
      return 7
    fi
    printf '%s' "$SMOKE_BODY"
  }
  docker() {
    printf 'docker %s\n' "$*" >>"$SMOKE_CALLS"
    [[ "${SMOKE_DOCKER_FAIL:-0}" == "0" ]] || return 1
    case "${!#}" in
      taxtronik-app) printf '172.18.0.1\n172.18.0.4\nfd00:18::1\nfd00:18::4\n' ;;
      taxtronik-traefik) printf '172.18.0.1\n172.18.0.9\n\n\n' ;;
      *) return 1 ;;
    esac
  }
  smoke_client_ip
)

test_client_ip_smoke_verdicts() {
  local out="$TMP_DIR/client-ip-smoke.out" calls="$TMP_DIR/client-ip-smoke.calls"
  export SMOKE_CALLS="$calls"
  smoke() { : >"$calls"; SMOKE_BODY="$1" run_client_ip_smoke >"$out" 2>&1; }

  : >"$calls"
  SMOKE_TRUST=false SMOKE_BODY='{"clientIp":null}' run_client_ip_smoke >"$out" 2>&1 || \
    test_fail "smoke ran without TRUST_PROXY_REQUIRED=true"
  assert_not_exists_or_empty "$calls"

  smoke '{"clientIp":"203.0.113.9"}' || { cat "$out" >&2; test_fail "a real client IP failed the smoke"; }
  assert_contains "$calls" "curl -fsS --max-time 10 https://kanzlei.example.de/api/health/client-ip"
  assert_contains "$out" "Die App ermittelt 203.0.113.9"

  if smoke '{"clientIp":null}'; then test_fail "an empty client IP passed the smoke"; fi
  assert_contains "$out" "keine Client-IP"

  if smoke '{"clientIp":"172.18.0.1"}'; then test_fail "the Docker gateway passed as client IP"; fi
  assert_contains "$out" "172.18.0.1, die Adresse des Proxys bzw. Docker-Netzes"
  if smoke '{"clientIp":"fd00:18::4"}'; then test_fail "the app's own IPv6 address passed as client IP"; fi

  # Die Adresse des verwalteten Traefik zaehlt nur auf dem Traefik-Pfad.
  smoke '{"clientIp":"172.18.0.9"}' || { cat "$out" >&2; test_fail "standard path rejected a foreign address"; }
  if SMOKE_METHOD=traefik smoke '{"clientIp":"172.18.0.9"}'; then
    test_fail "the managed Traefik address passed as client IP"
  fi
  assert_contains "$out" "Adresse des Proxys bzw. Docker-Netzes"

  if smoke FAIL; then test_fail "an unreachable public path passed the smoke"; fi
  assert_contains "$out" "nicht erreichbar"
  assert_contains "$out" "Failed to connect"
  [[ "$(grep -c '^curl ' "$calls")" == "6" ]] || test_fail "smoke did not retry the public path"

  if smoke 'kein JSON'; then test_fail "an invalid response passed the smoke"; fi
  assert_contains "$out" "ungueltige Antwort"
  if smoke '{"status":"ok"}'; then test_fail "a response without clientIp passed the smoke"; fi
  assert_contains "$out" "ungueltige Antwort"

  if SMOKE_DOCKER_FAIL=1 smoke '{"clientIp":"203.0.113.9"}'; then
    test_fail "smoke passed without the proxy/container addresses"
  fi
  assert_contains "$out" "Netzadressen von App/Proxy nicht ermittelbar"
  pass "client IP smoke fails for an empty, proxy or container address and for unverifiable answers"
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
    NODE_ENV=development
    TAXTRONIK_DEPLOY_CHANNEL=source
    TAXTRONIK_IMAGE_PREFIX=taxtronik
    prepare_source_version_for_checkout
    require_release_version
    [[ "$TAXTRONIK_VERSION" == "$expected" ]]
  ) || test_fail "source channel unexpectedly required a SemVer"
  pass "source channel uses an automatic commit identity instead of asking for SemVer"
}

# Ohne gueltigen HEAD-Commit bricht die Source-Kennung sofort ab. Frueher
# maskierte `export VAR="$(...)"` den Fehler: TAXTRONIK_VERSION wurde leer
# exportiert, und der Ablauf lief bis zum naechsten Gate weiter (SC2155).
test_source_version_without_head_stops_immediately() {
  local out="$TMP_DIR/source-version-no-head.out" checkout="$TMP_DIR/source-version-no-head" status=0
  mkdir -p "$checkout"
  GIT_CEILING_DIRECTORIES="$TMP_DIR" bash -c 'set -euo pipefail
    source "$1"
    ROOT="$2"
    NODE_ENV=development
    TAXTRONIK_DEPLOY_CHANNEL=source
    prepare_source_version_for_checkout
    printf "weitergelaufen: TAXTRONIK_VERSION=%s\n" "${TAXTRONIK_VERSION:-}"' \
    _ "$REPO_ROOT/scripts/ops-lib.sh" "$checkout" >"$out" 2>&1 || status=$?
  (( status != 0 )) || test_fail "source version without a valid HEAD was exported as an empty value"
  assert_contains "$out" "Source-Deployment braucht einen gueltigen Git-Checkout mit HEAD-Commit."
  assert_not_contains "$out" "weitergelaufen"
  pass "source version without a valid HEAD stops at once instead of exporting an empty version"
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
  local cli="$REPO_ROOT/taxtronik" source="$OPS_SOURCES" help="$TMP_DIR/cli-help.out"
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
    TAXTRONIK_DEPLOY_CHANNEL=release
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
    uname() { printf 'Linux\n'; }
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
  local source="$OPS_SOURCES" package_manager
  [[ "$HOST_NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] || test_fail "managed Node version is not pinned to Node 24"
  # CI (node-version-file) und Host-Setup muessen dieselbe exakte Node-Version nutzen.
  [[ "$HOST_NODE_VERSION" == "$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")" ]] || \
    test_fail "managed Node version drifted from .nvmrc"
  [[ "$HOST_NODE_LINUX_X64_SHA256" =~ ^[0-9a-f]{64}$ ]] || test_fail "Node x64 SHA-256 is not pinned"
  [[ "$HOST_NODE_LINUX_ARM64_SHA256" =~ ^[0-9a-f]{64}$ ]] || test_fail "Node arm64 SHA-256 is not pinned"
  package_manager="$(sed -n 's/^[[:space:]]*"packageManager":[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' \
    "$REPO_ROOT/package.json" | tr -d '\r')"
  [[ -n "$package_manager" && "$HOST_PNPM_VERSION" == "$package_manager" ]] || \
    test_fail "pnpm host version drifted from packageManager"
  assert_contains "$source" 'https://download.docker.com/linux/${os_id}/gpg'
  assert_contains "$source" 'https://nodejs.org/download/release/v${HOST_NODE_VERSION}/node-v${HOST_NODE_VERSION}-linux-${platform}.tar.xz'
  assert_not_contains "$source" 'curl | sh'
  pass "one-click installs only pinned Node/pnpm and the official Docker repository"
}

# S-04-Nacharbeit: Der 1-Klick-Installer (nur Debian/Ubuntu per apt) bringt
# ssh-keygen aus openssh-client mit und prueft es nach der Installation wie
# git und curl.
test_one_click_installs_openssh_client() {
  local bin="$TMP_DIR/one-click-base-bin" calls="$TMP_DIR/one-click-base.calls"
  local out="$TMP_DIR/one-click-base.out" cmd
  mkdir -p "$bin"
  for cmd in curl git tar xz sha256sum getent ss openssl flock; do
    printf '#!/bin/sh\nexit 0\n' >"$bin/$cmd"
    chmod +x "$bin/$cmd"
  done
  ln -sf "$(command -v date)" "$bin/date"
  base_packages() (
    PATH="$bin"
    apt-get() { printf 'apt-get %s\n' "$*" >>"$calls"; }
    install_one_click_base_packages
  )

  : >"$calls"
  base_packages >"$out" 2>&1 || { cat "$out" >&2; test_fail "base package installation failed"; }
  assert_contains "$out" "Fehlende Host-Basispakete installieren: ssh-keygen"
  assert_contains "$calls" "apt-get install -y ca-certificates curl git tar xz-utils coreutils libc-bin iproute2 openssl util-linux openssh-client"

  printf '#!/bin/sh\nexit 0\n' >"$bin/ssh-keygen"
  chmod +x "$bin/ssh-keygen"
  : >"$calls"
  base_packages >"$out" 2>&1 || { cat "$out" >&2; test_fail "complete host was not accepted"; }
  assert_not_exists_or_empty "$calls"

  : >"$calls"
  (
    require_root_for_one_click() { :; }
    install_one_click_base_packages() { :; }
    install_one_click_docker() { :; }
    install_one_click_node() { :; }
    install_one_click_pnpm() { :; }
    require_cmd() { printf 'require %s\n' "$1" >>"$calls"; }
    install_one_click_host_requirements
  ) >"$out" 2>&1 || { cat "$out" >&2; test_fail "one-click host requirements failed"; }
  assert_contains "$calls" "require ssh-keygen"
  pass "one-click installer installs openssh-client and verifies ssh-keygen"
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
  assert_contains "$dynamic" 'rule: "Host(`staff.example.de`) && Path(`/staff/login/password`)"'
  assert_contains "$dynamic" 'rule: "Host(`staff.example.de`) && Path(`/staff/login`) && Method(`POST`)"'
  assert_contains "$dynamic" 'priority: 110'
  assert_contains "$dynamic" 'rule: "Host(`portal.example.de`)"'
  assert_contains "$dynamic" 'rule: "Host(`n8n.example.de`)"'
  assert_contains "$dynamic" 'maxRequestBodyBytes: 65536'
  assert_contains "$dynamic" 'maxRequestBodyBytes: 27262976'
  assert_contains "$dynamic" 'middlewares: [taxtronik-login-body-limit]'
  assert_contains "$dynamic" 'middlewares: [taxtronik-app-body-limit]'
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
  assert_contains "$overlay" "/tmp:size=64m,mode=1777"
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
  assert_contains "$out" "OK       RISK_LAYER             extern: http://10.10.0.42:8000"
  assert_not_contains "$out" "RISK_LAYER_OPERATOR_TOKEN"
  pass "doctor accepts internal Risk-Layer URL without INTERNAL_FETCH_HOSTS"
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
  # Bestandswert main bleibt lauffaehig, wird aber als beweglich gemeldet.
  assert_contains "$out" "WARN     SIGNAL_GIT_REF         'main' ist beweglich"

  set_env_file_value "$env_file" SIGNAL_GIT_REF "$(printf 'a%.0s' {1..40})"
  run_doctor_with_env "$env_file" "$out" || {
    cat "$out" >&2
    test_fail "doctor rejected a Signal source checkout pinned to a commit"
  }
  assert_contains "$out" "OK       SIGNAL_GIT_REF         fester Commit aaaaaaaaaaaa"
  assert_not_contains "$out" "ist beweglich"

  set_env_file_value "$env_file" SIGNAL_GIT_REF refs/tags/v1.2.3
  run_doctor_with_env "$env_file" "$out" || test_fail "doctor rejected an explicit Signal tag ref"
  assert_contains "$out" "OK       SIGNAL_GIT_REF         refs/tags/v1.2.3 (Tag serverseitig schuetzen"

  set_env_file_value "$env_file" SIGNAL_GIT_REF ""
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted managed Signal source without an explicit Git ref"
  fi
  assert_contains "$out" "FEHLT    SIGNAL_GIT_REF         fehlt/ungueltig: vollstaendigen Commit-SHA"
  pass "doctor accepts managed Signal from a controlled Git checkout and flags moving refs"
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
    SIGNAL_LLM_DIR="$TMP_DIR/managed-lifecycle-signal-llm"
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
  assert_key_equals "$env_file" RISK_LAYER_LLM_BACKEND cpu
  assert_key_equals "$env_file" RISK_LAYER_LLM_TIMEOUT 900
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
  assert_key_equals "$env_file" SIGNAL_LLM_DIR ""
  assert_key_equals "$env_file" RISK_LAYER_LLM_BACKEND auto
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
    SIGNAL_LLM_DIR="$TMP_DIR/managed-signal-llm"
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
    ENVFILE="$TMP_DIR/legacy-native-signal.no-env"
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
    SIGNAL_LLM_DIR="$TMP_DIR/managed-lifecycle-signal-llm"
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
  assert_contains "$calls" "provision-signal-llm.py --output /managed-llm"
  assert_contains "$calls" "LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/torch/lib"
  assert_contains "$calls" "$TMP_DIR/managed-lifecycle-signal-llm:/managed-llm"
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
    SIGNAL_LLM_DIR="$TMP_DIR/managed-source-signal-llm"
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

test_managed_signal_source_update_skips_unchanged_image_unless_requested() {
  local origin="$TMP_DIR/signal-cache-origin" checkout="$TMP_DIR/signal-cache-checkout"
  local build_root="$TMP_DIR/signal-cache-build-root" build_log="$TMP_DIR/signal-cache-build.log"
  local out="$TMP_DIR/signal-cache.out" origin_url sha target
  mkdir -p "$origin/scripts" "$build_root"
  git -C "$origin" init -q -b main
  git -C "$origin" config user.name TaxTronik-Test
  git -C "$origin" config user.email test@taxtronik.invalid
  printf 'signal source\n' >"$origin/README.md"
  cat >"$origin/scripts/build-managed-image.sh" <<EOF
#!/bin/sh
printf 'build %s\\n' "\$1" >>'$build_log'
EOF
  git -C "$origin" add README.md scripts/build-managed-image.sh
  git -C "$origin" commit -qm initial
  origin_url="$(git -C "$origin" rev-parse --show-toplevel)"
  sha="$(git -C "$origin" rev-parse HEAD)"
  target="taxtronik/risk-layer-engine:source-${sha:0:12}"

  if ! (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin_url"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$checkout"
    SIGNAL_IMAGE="$target"
    SIGNAL_FORCE_REBUILD=""
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    signal_rebuild_prompt_available() { return 1; }
    docker() { [[ "$1" == image && "$2" == inspect && "$3" == "$target" ]]; }
    build_signal_from_source update
  ) >"$out" 2>&1; then
    cat "$out" >&2
    test_fail "unchanged Signal source update failed"
  fi
  assert_not_exists_or_empty "$build_log"
  assert_contains "$out" "Signal-Quellstand unveraendert"
  assert_contains "$out" "Signal-Build uebersprungen"

  if ! (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin_url"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$checkout"
    SIGNAL_IMAGE="$target"
    SIGNAL_FORCE_REBUILD=1
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    docker() { [[ "$1" == image && "$2" == inspect && "$3" == "$target" ]]; }
    build_signal_from_source update
  ) >>"$out" 2>&1; then
    cat "$out" >&2
    test_fail "forced unchanged Signal rebuild failed"
  fi
  assert_contains "$build_log" "build $target"
  assert_contains "$out" "SIGNAL_FORCE_REBUILD ist aktiv"

  printf 'changed source\n' >>"$origin/README.md"
  git -C "$origin" add README.md
  git -C "$origin" commit -qm changed
  sha="$(git -C "$origin" rev-parse HEAD)"
  local changed_target="taxtronik/risk-layer-engine:source-${sha:0:12}"
  if ! (
    ROOT="$build_root"
    SIGNAL_GIT_URL="$origin_url"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$checkout"
    SIGNAL_IMAGE="$target"
    SIGNAL_FORCE_REBUILD=""
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    docker() { return 1; }
    build_signal_from_source update
  ) >>"$out" 2>&1; then
    cat "$out" >&2
    test_fail "changed Signal source update failed"
  fi
  assert_contains "$build_log" "build $changed_target"
  assert_contains "$out" "Neuer Signal-Quellstand erkannt"
  pass "unchanged managed Signal source updates reuse the image unless rebuild is requested"
}

test_managed_signal_source_update_honors_interactive_rebuild_choice() {
  (
    signal_rebuild_prompt_available() { return 0; }
    SIGNAL_FORCE_REBUILD="" signal_rebuild_unchanged_requested update "$(printf 'a%.0s' {1..40})"
  ) <<<"ja" >/dev/null || test_fail "interactive Signal rebuild confirmation was ignored"
  if (
    signal_rebuild_prompt_available() { return 0; }
    SIGNAL_FORCE_REBUILD="" signal_rebuild_unchanged_requested update "$(printf 'a%.0s' {1..40})"
  ) <<<"nein" >/dev/null; then
    test_fail "interactive Signal rebuild rejection was ignored"
  fi
  pass "unchanged Signal rebuild prompt honors the explicit operator choice"
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
  assert_contains "$service" "RISK_LAYER_LLM_BACKEND: \${RISK_LAYER_LLM_BACKEND:-cpu}"
  assert_contains "$service" "RISK_LAYER_LLM_TIMEOUT: \${RISK_LAYER_LLM_TIMEOUT:-900}"
  assert_contains "$service" "LD_LIBRARY_PATH: /usr/local/lib/python3.12/site-packages/torch/lib"
  assert_contains "$service" "HF_HUB_OFFLINE: '1'"
  assert_contains "$service" "TRANSFORMERS_OFFLINE: '1'"
  assert_contains "$service" "- /release/catalog/begriffe.yaml"
  assert_contains "$service" "- /release/corpus/graph.sqlite"
  assert_contains "$service" "- risk_layer_definitionen:/app/definitionen"
  assert_contains "$service" "- risk_layer_embedding_state:/state/embedding"
  assert_contains "$service" "- risk_layer_embedding_cache:/cache"
  assert_contains "$service" "- /managed-llm/granite-4.1-8b-Q5_K_M.gguf"
  assert_contains "$service" "- /managed-llm/runtime/llama-server"
  assert_contains "$service" "- \${SIGNAL_LLM_DIR:-../../.taxtronik/signal-llm}:/managed-llm:ro"
  assert_contains "$service" "body.get('ok') is True"
  assert_not_contains "$service" "llm_ready="
  assert_not_contains "$service" "refresh_available') is True"
  assert_not_contains "$service" "/data/katalog"
  assert_not_contains "$service" "/data/corpus"
  pass "Signal Compose contract stays self-contained, persistent and offline"
}

# Fachkatalog: ACCESS-TENANT-RLS-001
test_hardware_aaguid_allowlist_is_forwarded_to_app() {
  local service="$TMP_DIR/app-compose-service.yml"
  sed -n '/^  app:/,/^  worker:/p' \
    "$REPO_ROOT/infra/compose/docker-compose.app.yml" >"$service"
  assert_contains "$service" \
    'WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: ${WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST:-}'
  assert_contains "$service" \
    'WEBAUTHN_HARDWARE_POLICY_REVISION: ${WEBAUTHN_HARDWARE_POLICY_REVISION:-1}'
  pass "Hardware AAGUID allowlist is forwarded to the production app container"
}

# Fachkatalog: ACCESS-TENANT-RLS-001
# P-23: the fido-mds-refresh job fetches FIDO metadata only while the
# hardware access is enabled, so the worker needs the same allowlist.
test_hardware_aaguid_allowlist_is_forwarded_to_worker() {
  local service="$TMP_DIR/worker-compose-service.yml"
  sed -n '/^  worker:/,/^  migrate:/p' \
    "$REPO_ROOT/infra/compose/docker-compose.app.yml" >"$service"
  assert_contains "$service" \
    'WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST: ${WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST:-}'
  pass "Hardware AAGUID allowlist is forwarded to the production worker container"
}

test_trust_proxy_hops_is_forwarded_to_app() {
  local service="$TMP_DIR/app-compose-service-proxy-hops.yml"
  sed -n '/^  app:/,/^  worker:/p' \
    "$REPO_ROOT/infra/compose/docker-compose.app.yml" >"$service"
  assert_contains "$service" 'TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-1}'
  pass "TRUST_PROXY_HOPS is forwarded to the production app container"
}

test_windows_signal_dev_start_provisions_embedding_operator() {
  local script="$REPO_ROOT/scripts/win/Start-SignalDev.ps1"
  [[ -f "$script" ]] || test_fail "Windows Signal dev starter is missing"
  assert_contains "$script" "requirements-embedding-windows-cpu-py312-lock.txt"
  assert_contains "$script" "requirements-embedding-windows-amd-py312-lock.txt"
  assert_contains "$script" "torch.cuda.is_available()"
  assert_contains "$script" "[ValidateSet('auto', 'cpu', 'gpu')][string]\$LlmBackend = 'auto'"
  assert_contains "$script" "Set-EnvValue 'RISK_LAYER_LLM_BACKEND' \$LlmBackend"
  assert_contains "$script" "installierte_engine(backend='cpu') or download_engine(backend='cpu')"
  assert_contains "$script" "@('--llm-bin', \$llmBinary)"
  assert_contains "$script" "RISK_LAYER_OPERATOR_TOKEN"
  assert_contains "$script" "RISK_LAYER_EMBEDDING_DIR"
  assert_contains "$script" "RISK_LAYER_EMB_DEVICE"
  assert_contains "$script" "risk_layer.web"
  assert_contains "$script" "--llm-autostart"
  assert_not_contains "$script" 'Write-Host $operatorToken'
  assert_not_contains "$script" 'Write-Output $operatorToken'
  pass "Windows Signal dev starter provisions GPU/CPU embedding without leaking secrets"
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
    unset TAXTRONIK_BUILD_MEMORY_LIMIT TAXTRONIK_BUILD_MEMORY_RESERVE
    host_available_memory_kib() { printf '6291456\n'; }
    build_images
  ) >"$out" 2>&1; then
    test_fail "local build started without memory limit plus system reserve"
  fi

  assert_contains "$out" "Lokalbuild wegen RAM-Schutz abgebrochen"
  assert_contains "$out" "erforderlich 7168 MiB"
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
    GWG_ANSWER_043='gwg_043.policy:gwg_representative.gwg_representative_isolation'
    compose() { fake_gwg_invariant_psql "$@"; }
    docker() { test_fail "host ports must not be inspected after GwG schema drift"; }
    deploy_readiness
  ) >"$out" 2>&1; then
    test_fail "deploy_readiness accepted an incomplete GwG protection schema"
  fi
  assert_contains "$out" "gwg_043.policy:gwg_representative.gwg_representative_isolation"
  assert_contains "$out" "GwG-Datenbankschutz entspricht nicht dem Migrationsstand"
  pass "deploy readiness fails closed on GwG schema drift"
}

test_deploy_readiness_reports_gwg_sql_error_separately() {
  local out="$TMP_DIR/readiness-gwg-error.out"
  if (
    GWG_ANSWER_043=ERROR
    compose() { fake_gwg_invariant_psql "$@"; }
    docker() { test_fail "host ports must not be inspected without a verified GwG schema"; }
    deploy_readiness
  ) >"$out" 2>&1; then
    test_fail "deploy_readiness accepted an unverifiable GwG protection schema"
  fi
  assert_contains "$out" "GwG-Datenbankschutz konnte wegen eines SQL-/Verbindungsfehlers nicht geprueft werden"
  assert_not_contains "$out" "entspricht nicht dem Migrationsstand"
  assert_not_contains "$out" "GwG-Invariante verletzt"
  pass "deploy readiness reports GwG SQL errors separately from schema drift"
}

test_run_migrations_blocks_incomplete_gwg_schema_before_writer_start() {
  local out="$TMP_DIR/migrate-gwg-drift.out" steps="$TMP_DIR/migrate-gwg-drift.steps"
  if (
    GWG_ANSWER_034='gwg_034.trigger:gwg_check.gwg_check_no_hard_delete'
    begin_migration_transition() { printf 'pending\n' >>"$steps"; }
    compose() {
      if [[ "$*" == "run --rm migrate" ]]; then
        printf 'migrate\n' >>"$steps"
      else
        printf 'gwg-integrity\n' >>"$steps"
        fake_gwg_invariant_psql "$@"
      fi
    }
    run_migrations
    printf 'writer-start\n' >>"$steps"
  ) >"$out" 2>&1; then
    test_fail "run_migrations accepted an incomplete GwG protection schema"
  fi

  assert_file_equals "$steps" $'pending\nmigrate\ngwg-integrity'
  assert_contains "$out" "gwg_034.trigger:gwg_check.gwg_check_no_hard_delete"
  assert_contains "$out" "GwG-Datenbankschutz ist unvollstaendig; neue Writer werden nicht aktiviert"
  assert_not_contains "$steps" "writer-start"
  pass "migration flow validates GwG guards before any writer can start"
}

test_run_migrations_reports_gwg_sql_error_before_writer_start() {
  local out="$TMP_DIR/migrate-gwg-error.out" steps="$TMP_DIR/migrate-gwg-error.steps"
  if (
    GWG_ANSWER_034=ERROR
    begin_migration_transition() { printf 'pending\n' >>"$steps"; }
    compose() {
      if [[ "$*" == "run --rm migrate" ]]; then
        printf 'migrate\n' >>"$steps"
      else
        printf 'gwg-integrity\n' >>"$steps"
        fake_gwg_invariant_psql "$@"
      fi
    }
    run_migrations
    printf 'writer-start\n' >>"$steps"
  ) >"$out" 2>&1; then
    test_fail "run_migrations accepted an unverifiable GwG protection schema"
  fi

  assert_file_equals "$steps" $'pending\nmigrate\ngwg-integrity'
  assert_contains "$out" "SQL-/Verbindungsfehler (Exit 3), keine Aussage ueber den Schutz"
  assert_contains "$out" 'relation "information_schema.columns" does not exist'
  assert_contains "$out" "GwG-Datenbankschutz konnte wegen eines SQL-/Verbindungsfehlers nicht geprueft werden"
  assert_not_contains "$out" "GwG-Datenbankschutz ist unvollstaendig"
  assert_not_contains "$out" "GwG-Invariante verletzt"
  pass "migration flow reports an unverifiable GwG schema as SQL error and starts no writer"
}

# Nur ein eindeutiges `f` der Schema-Sonde gilt als Erstdeploy ohne
# Pflichtbackup. Eine gescheiterte oder unklare Sonde stoppt vor der Migration
# und zeigt den psql-Fehler, statt ihn als Erstdeploy zu verschlucken.
test_pre_migration_backup_requires_a_proven_first_deploy() {
  local out="$TMP_DIR/pre-migration-backup.out" steps="$TMP_DIR/pre-migration-backup.steps"
  : >"$steps"
  (
    compose() { printf 't\n'; }
    run_backup() { printf 'backup\n' >>"$steps"; }
    backup_before_migrations
    printf 'migrate\n' >>"$steps"
  ) >"$out" 2>&1 || test_fail "existing schema did not run the pre-migration backup"
  assert_file_equals "$steps" $'backup\nmigrate'

  : >"$steps"
  (
    compose() { printf 'f\n'; }
    run_backup() { printf 'backup\n' >>"$steps"; }
    backup_before_migrations
    printf 'migrate\n' >>"$steps"
  ) >"$out" 2>&1 || test_fail "proven first deploy was blocked"
  assert_file_equals "$steps" 'migrate'
  assert_contains "$out" "Erstdeploy erkannt"

  : >"$steps"
  if (
    compose() { printf 'psql: error: connection to server failed\n' >&2; return 2; }
    run_backup() { printf 'backup\n' >>"$steps"; }
    backup_before_migrations
    printf 'migrate\n' >>"$steps"
  ) >"$out" 2>&1; then
    test_fail "failed schema probe was treated as a first deploy"
  fi
  assert_file_equals "$steps" ''
  assert_contains "$out" "psql: error: connection to server failed"
  assert_contains "$out" "ohne Pflichtbackup wird nicht migriert"
  assert_not_contains "$out" "Erstdeploy erkannt"

  : >"$steps"
  if (
    compose() { :; }
    run_backup() { printf 'backup\n' >>"$steps"; }
    backup_before_migrations
    printf 'migrate\n' >>"$steps"
  ) >"$out" 2>&1; then
    test_fail "empty schema probe answer was treated as a first deploy"
  fi
  assert_file_equals "$steps" ''
  assert_contains "$out" "lieferte '' statt t oder f"
  pass "pre-migration backup is skipped only for a proven first deploy and a failed probe stops the migration"
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

MOCK_SOURCE_COMMIT=cccccccccccccccccccccccccccccccccccccccc
MOCK_TARGET_COMMIT=dddddddddddddddddddddddddddddddddddddddd

# Gemeinsame Stubs fuer Update-Ablauftests: alles ausser Git, Remote-Auswahl und
# der S-04-Signaturentscheidung. Pfade und der Signer-Default zeigen in den
# Test-Root, damit kein Host-/etc/taxtronik das Ergebnis beeinflusst.
stub_update_runtime() {
  ROOT="${OPS_MOCK_ROOT:-$TMP_DIR/mock-update-root}"
  ENVFILE="$ROOT/.env"
  STATE="$ROOT/.state"
  MIGRATION_PENDING="$ROOT/.migration-pending"
  DB_RESTORE_AUTHORIZATION="$ROOT/.database-restored"
  UPDATE_HANDOFF="$ROOT/.update-handoff"
  TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="${OPS_SIGNERS_DEFAULT:-$TMP_DIR/absent-default-allowed-signers}"
  mkdir -p "$ROOT"

  record_step() { printf '%s\n' "$*" >>"$OPS_SEQUENCE"; }
  require_cmd() { :; }
  prepare_env_interactive() { record_step prepare-env; }
  load_env() { record_step load-env; }
  prepare_source_version_for_checkout() { record_step prepare-source-version; }
  preflight_common() { record_step preflight; }
  assert_production_env() { record_step assert-production; }
  require_release_version() { record_step require-version; }
  assert_no_database_restore_pending() { :; }
  # Hermetisch: Ablaufbetrieb kommt ausschliesslich aus OPS_NODE_ENV.
  NODE_ENV="${OPS_NODE_ENV:-test}"
  if [[ "${OPS_RELEASE_CHANNEL:-0}" == "1" ]]; then
    TAXTRONIK_DEPLOY_CHANNEL=release
    images_from_registry() { return 0; }
    resolve_release_contract() {
      record_step resolve-release-contract
      UPDATE_COMMIT_SHA="$MOCK_TARGET_COMMIT"
    }
    fetch_verified_release_tag() { record_step "fetch-verified-release-tag $*"; }
  else
    TAXTRONIK_DEPLOY_CHANNEL=source
    images_from_registry() { return 1; }
  fi
  start_infra() { record_step start-infra; }
  wait_postgres_healthy() { record_step wait-postgres; }
  sync_postgres_roles_from_env() { record_step sync-roles; }
  run_backup() { record_step backup-old-checkout; return "${OPS_BACKUP_STATUS:-0}"; }
  ensure_host_tool_deps() { record_step ensure-host-deps; }
  prepare_release_contract() { record_step prepare-release-contract; }
  provide_images() { record_step provide-images; }
  assert_app_env_schema() {
    record_step assert-app-env-schema
    [[ "${OPS_SCHEMA_STATUS:-0}" == "0" ]] || die "Konfiguration verletzt das Schema des Ziel-Images (Test)."
  }
  provide_traefik_for_deploy() { record_step provide-traefik; }
  provide_signal_for_deploy() { record_step provide-signal; }
  run_migrations() { record_step migrate; }
  start_signal_for_deploy() { record_step start-signal; }
  start_apps_for_activation() { record_step "start-apps $*"; }
  smoke_health() { record_step smoke-health; }
  smoke_public_frontend() { record_step smoke-public-frontend; }
  smoke_client_ip() { record_step smoke-client-ip; }
  deploy_readiness() { record_step deploy-readiness; }
  finalize_release_contract() { record_step finalize-release-contract; }
  reexec_updated_operator() { record_step reexec-updated-operator; }
  image_tag() { printf 'test-version'; }
}

# Ablauf mit Git-Attrappe: OPS_CHECKOUT_CHANGES=1 liefert einen neuen
# Ziel-Commit, sonst steht origin/main auf dem installierten Commit. Die
# S-04-Entscheidung wird nur protokolliert; echte Signaturen pruefen die
# run_real_git_update-Tests.
run_mock_update() (
  stub_update_runtime
  git() {
    record_step "git $*"
    record_step "git-umask $(umask) $*"
    if [[ "$*" == "-C $ROOT rev-parse HEAD" ]]; then
      if [[ -f "$ROOT/.mock-checkout-advanced" ]]; then printf '%s\n' "$MOCK_TARGET_COMMIT"
      else printf '%s\n' "$MOCK_SOURCE_COMMIT"; fi
      return 0
    fi
    if [[ "$*" == "-C $ROOT rev-parse --verify --quiet origin/main^{commit}" ]]; then
      if [[ "${OPS_CHECKOUT_CHANGES:-0}" == "1" ]]; then printf '%s\n' "$MOCK_TARGET_COMMIT"
      else printf '%s\n' "$MOCK_SOURCE_COMMIT"; fi
      return 0
    fi
    if [[ "$*" == "merge --ff-only "* && "${OPS_CHECKOUT_CHANGES:-0}" == "1" ]]; then
      : >"$ROOT/.mock-checkout-advanced"
    fi
    if [[ "$*" == "-C $ROOT merge-base --is-ancestor "* ]]; then return 0; fi
  }
  deployment_git_remote() { printf 'origin'; }
  assert_source_update_trust_ready() { record_step source-trust-ready; }
  authorize_source_update_target() { record_step "authorize-source-update $*"; }
  cmd_update
)

# Ablauf mit echtem Git und echter S-04-Pruefung gegen einen geklonten Checkout
# (OPS_MOCK_ROOT); nur Docker/DB/Build sind ersetzt.
run_real_git_update() (
  stub_update_runtime
  cmd_update
)

test_update_backs_up_old_checkout_before_fetch() {
  local sequence="$TMP_DIR/update-order.log" out="$TMP_DIR/update-order.out"
  local root="$TMP_DIR/mock-update-order-root"
  : >"$sequence"
  OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" run_mock_update >"$out" 2>&1 || test_fail "mock update failed"
  assert_before "$sequence" "source-trust-ready" "backup-old-checkout"
  assert_before "$sequence" "backup-old-checkout" "git fetch origin"
  assert_before "$sequence" "git fetch origin" "authorize-source-update $MOCK_SOURCE_COMMIT $MOCK_SOURCE_COMMIT"
  assert_before "$sequence" "authorize-source-update" "git merge --ff-only $MOCK_SOURCE_COMMIT"
  assert_before "$sequence" "backup-old-checkout" "git merge --ff-only $MOCK_SOURCE_COMMIT"
  assert_before "$sequence" "git merge --ff-only $MOCK_SOURCE_COMMIT" "ensure-host-deps"
  assert_before "$sequence" "ensure-host-deps" "provide-images"
  assert_contains "$sequence" "git-umask 0022 merge --ff-only $MOCK_SOURCE_COMMIT"
  assert_contains "$sequence" "git-umask 0077 fetch origin"
  assert_not_contains "$sequence" "merge --ff-only origin/main"
  # B-05: Schemapruefung im Ziel-Image nach provide_images, vor der Migration.
  assert_before "$sequence" "provide-images" "assert-app-env-schema"
  assert_before "$sequence" "assert-app-env-schema" "migrate"
  # B3: Client-IP-Smoke nach dem oeffentlichen Smoke, vor Readiness und
  # Finalisierung des Last-Good-Vertrags.
  assert_before "$sequence" "smoke-public-frontend" "smoke-client-ip"
  assert_before "$sequence" "smoke-client-ip" "deploy-readiness"
  assert_before "$sequence" "smoke-client-ip" "finalize-release-contract"
  pass "update completes mandatory old-checkout backup before fetch and merge"
}

# B-05 (b): Ein Schemafehler des Ziel-Images stoppt das Update vor jeder
# Migration und jedem Containerwechsel.
test_update_schema_error_stops_before_migration() {
  local sequence="$TMP_DIR/update-schema.log" out="$TMP_DIR/update-schema.out"
  local root="$TMP_DIR/mock-update-schema-root"
  : >"$sequence"
  if OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_SCHEMA_STATUS=1 run_mock_update >"$out" 2>&1; then
    test_fail "update continued after a schema error of the target image"
  fi
  assert_before "$sequence" "provide-images" "assert-app-env-schema"
  assert_not_contains "$sequence" "migrate"
  assert_not_contains "$sequence" "start-apps"
  assert_not_contains "$sequence" "finalize-release-contract"
  pass "a schema error of the target image stops the update before migration and activation"
}

test_update_backup_failure_leaves_checkout_untouched() {
  local sequence="$TMP_DIR/update-backup-fail.log" out="$TMP_DIR/update-backup-fail.out"
  local root="$TMP_DIR/mock-update-backup-fail-root"
  : >"$sequence"
  if OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_BACKUP_STATUS=23 run_mock_update >"$out" 2>&1; then
    test_fail "update continued despite failed mandatory backup"
  fi
  assert_contains "$sequence" "backup-old-checkout"
  assert_not_contains "$sequence" "git fetch"
  assert_not_contains "$sequence" "git merge"
  assert_not_contains "$sequence" "provide-images"
  assert_contains "$out" "Code und Arbeitsbaum bleiben unveraendert"
  pass "failed mandatory backup prevents every checkout change"
}

test_changed_update_reloads_operator_and_resumes_same_run() {
  local root="$TMP_DIR/mock-update-handoff-root"
  local marker="$root/.update-handoff" sequence="$TMP_DIR/update-handoff.log"
  local first_out="$TMP_DIR/update-handoff-first.out" second_out="$TMP_DIR/update-handoff-second.out"
  : >"$sequence"

  OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_CHECKOUT_CHANGES=1 \
    run_mock_update >"$first_out" 2>&1 || test_fail "changed mock update failed before operator handoff"
  [[ -f "$marker" ]] || test_fail "changed checkout did not persist an update handoff"
  [[ "$(file_mode "$marker")" == "600" ]] || test_fail "update handoff mode is not 0600"
  assert_key_equals "$marker" checkout_source_commit cccccccccccccccccccccccccccccccccccccccc
  assert_key_equals "$marker" checkout_target_commit dddddddddddddddddddddddddddddddddddddddd
  assert_contains "$sequence" "reexec-updated-operator"
  assert_not_contains "$sequence" "ensure-host-deps"
  # S-04: Der exakte Ziel-Commit wird vor dem Merge und damit vor dem Start
  # des neuen Operators autorisiert und genau dieser Commit gemergt.
  assert_before "$sequence" "authorize-source-update $MOCK_SOURCE_COMMIT $MOCK_TARGET_COMMIT" \
    "git merge --ff-only $MOCK_TARGET_COMMIT"
  assert_before "$sequence" "git merge --ff-only $MOCK_TARGET_COMMIT" "reexec-updated-operator"

  OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_CHECKOUT_CHANGES=1 \
    run_mock_update >"$second_out" 2>&1 || test_fail "new operator did not resume the handed-off update"
  [[ ! -e "$marker" ]] || test_fail "resumed update did not consume its handoff"
  [[ "$(grep -Fc 'backup-old-checkout' "$sequence")" == "1" ]] || \
    test_fail "operator handoff repeated or skipped the mandatory backup"
  [[ "$(grep -Fc 'git fetch origin' "$sequence")" == "1" ]] || \
    test_fail "operator handoff repeated the checkout update"
  assert_before "$sequence" "backup-old-checkout" "reexec-updated-operator"
  assert_before "$sequence" "reexec-updated-operator" "ensure-host-deps"
  assert_contains "$second_out" "Sicheren Update-Handoff uebernommen"
  pass "changed checkout reloads the new operator and resumes one update invocation safely"
}

test_invalid_update_handoff_restarts_with_backup() {
  local root="$TMP_DIR/mock-update-invalid-handoff-root"
  local marker="$root/.update-handoff" sequence="$TMP_DIR/update-invalid-handoff.log"
  local first_out="$TMP_DIR/update-invalid-handoff-first.out" second_out="$TMP_DIR/update-invalid-handoff-second.out"
  : >"$sequence"

  OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_CHECKOUT_CHANGES=1 \
    run_mock_update >"$first_out" 2>&1 || test_fail "changed mock update failed before invalid-handoff test"
  [[ -f "$marker" ]] || test_fail "invalid-handoff test did not create its handoff"
  chmod 0644 "$marker"

  OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$root" OPS_CHECKOUT_CHANGES=1 \
    run_mock_update >"$second_out" 2>&1 || test_fail "invalid handoff did not fall back to a fresh update"
  [[ ! -e "$marker" ]] || test_fail "invalid handoff was not discarded"
  [[ "$(grep -Fc 'backup-old-checkout' "$sequence")" == "2" ]] || \
    test_fail "invalid handoff skipped the new mandatory backup"
  assert_contains "$second_out" "ungueltigen Update-Handoff verworfen"
  pass "invalid update handoff is discarded and can never skip a fresh backup"
}

# ---------------------------------------------------------------------------
# S-04: Signaturbindung des Source-Kanals. Wegwerf-SSH-Schluessel und
# Repositories entstehen ausschliesslich im TMP_DIR. GIT_CONFIG_GLOBAL zeigt
# auf eine Testdatei und GIT_CONFIG_NOSYSTEM blendet die Systemkonfiguration
# aus, damit weder Signierprogramm noch Signer des Testrechners mitwirken.
# Ohne ssh-keygen (openssh-client) werden die Signaturtests lokal sichtbar
# uebersprungen; in CI (CI gesetzt) ist das ein Fehler.
# ---------------------------------------------------------------------------
S04_DIR="$TMP_DIR/s04"

s04_signature_tools_available() {
  command -v ssh-keygen >/dev/null 2>&1 && return 0
  [[ -z "${CI:-}" ]] || test_fail "ssh-keygen (openssh-client) fehlt; S-04-Signaturtests sind in CI Pflicht"
  return 1
}

s04_git() { GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

s04_git_fixtures() {
  [[ -f "$S04_DIR/gitconfig" ]] && return 0
  mkdir -p "$S04_DIR"
  printf '[user]\n\tname = TaxTronik-Test\n\temail = test@taxtronik.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n' \
    >"$S04_DIR/gitconfig"
}

s04_allowed_signers() {
  local key="$1" out="$2"
  printf '%s@taxtronik.invalid namespaces="git" %s\n' "$key" "$(cut -d' ' -f1,2 "$S04_DIR/$key.pub")" >"$out"
}

# Jeder Test laeuft in einer eigenen Subshell (run_test); ob die Schluessel
# schon existieren, zeigt deshalb die zuletzt angelegte Datei statt eines
# Shell-Flags. Reste eines abgebrochenen Laufs werden vorher entfernt.
s04_key_fixtures() {
  s04_git_fixtures
  [[ -f "$S04_DIR/rogue_signers" ]] && return 0
  rm -f -- "$S04_DIR/trusted" "$S04_DIR/trusted.pub" "$S04_DIR/rogue" "$S04_DIR/rogue.pub" \
    "$S04_DIR/allowed_signers"
  ssh-keygen -q -t ed25519 -N '' -C trusted@taxtronik.invalid -f "$S04_DIR/trusted"
  ssh-keygen -q -t ed25519 -N '' -C rogue@taxtronik.invalid -f "$S04_DIR/rogue"
  s04_allowed_signers trusted "$S04_DIR/allowed_signers"
  s04_allowed_signers rogue "$S04_DIR/rogue_signers"
}

# Commit im Upstream, wahlweise mit einem Wegwerf-Schluessel SSH-signiert.
# Ausgabe: Commit-SHA. Bereits gestagte Dateien werden mit uebernommen.
s04_commit() {
  local repo="$1" signer="$2" message="$3"
  printf '%s\n' "$message" >"$repo/CHANGE.txt"
  s04_git -C "$repo" add CHANGE.txt
  if [[ -n "$signer" ]]; then
    s04_git -C "$repo" -c gpg.format=ssh -c gpg.ssh.program="$(command -v ssh-keygen)" \
      -c user.signingkey="$S04_DIR/$signer" commit -q -S -m "$message"
  else
    s04_git -C "$repo" commit -q -m "$message"
  fi
  s04_git -C "$repo" rev-parse HEAD
}

s04_signed_tag() {
  local repo="$1" signer="$2" name="$3" target="$4"
  s04_git -C "$repo" -c gpg.format=ssh -c gpg.ssh.program="$(command -v ssh-keygen)" \
    -c user.signingkey="$S04_DIR/$signer" tag -s -m "Freigabe $name" "$name" "$target"
}

# Upstream mit installiertem Basis-Commit und ein Operator-Checkout davon.
s04_repos() {
  local name="$1"
  s04_git_fixtures
  S04_UPSTREAM="$S04_DIR/$name-upstream"
  S04_CHECKOUT="$S04_DIR/$name-checkout"
  mkdir -p "$S04_UPSTREAM"
  s04_git -C "$S04_UPSTREAM" init -q -b main
  S04_BASE="$(s04_commit "$S04_UPSTREAM" "" "installierter Stand")"
  s04_git clone -q "$S04_UPSTREAM" "$S04_CHECKOUT"
}

s04_head() { s04_git -C "$S04_CHECKOUT" rev-parse HEAD; }

# Echtes `cmd_update` (Git + S-04) gegen S04_CHECKOUT, standardmaessig in
# Produktion (dort verweigert); Signaturpfade laufen mit OPS_NODE_ENV=development.
# Signer/Opt-out kommen ausschliesslich aus OPS_SIGNERS/OPS_OPT_OUT.
s04_run_update() {
  local sequence="$1" out="$2"
  : >"$sequence"
  GIT_CONFIG_GLOBAL="${OPS_GITCONFIG:-$S04_DIR/gitconfig}" GIT_CONFIG_NOSYSTEM=1 \
    OPS_NODE_ENV="${OPS_NODE_ENV:-production}" TAXTRONIK_GIT_REMOTE="" TAXTRONIK_UPDATE_REF="" \
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS="${OPS_SIGNERS:-}" \
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE="${OPS_OPT_OUT:-}" \
    OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$S04_CHECKOUT" run_real_git_update >"$out" 2>&1
}

test_source_update_accepts_signed_commit_and_signed_tag() {
  local desc="outside production a source update merges and reloads only after a pinned signer verified the exact commit or its annotated tag"
  s04_signature_tools_available || { skip_test "$desc" "ssh-keygen fehlt"; return 0; }
  s04_key_fixtures
  local sequence="$TMP_DIR/s04-signed.seq" out="$TMP_DIR/s04-signed.out" signed tagged
  local OPS_NODE_ENV=development
  s04_repos signed
  signed="$(s04_commit "$S04_UPSTREAM" trusted "signierter Stand")"

  OPS_SIGNERS="$S04_DIR/allowed_signers" s04_run_update "$sequence" "$out" || {
    cat "$out" >&2
    test_fail "update rejected a commit signed by a pinned signer"
  }
  [[ "$(s04_head)" == "$signed" ]] || test_fail "verified signed commit was not merged"
  assert_contains "$out" "Source-Update ist an SSH-Signaturen gebunden"
  assert_contains "$out" "Signierter Source-Stand bestaetigt: Commit ${signed:0:12}"
  assert_contains "$out" 'Good "git" signature for trusted@taxtronik.invalid'
  assert_before "$sequence" "backup-old-checkout" "reexec-updated-operator"
  assert_key_equals "$S04_CHECKOUT/.update-handoff" checkout_target_commit "$signed"

  # Unsignierter Commit, freigegeben durch einen signierten annotierten Tag mit
  # genau diesem Commit als Ziel.
  rm -f -- "$S04_CHECKOUT/.update-handoff"
  tagged="$(s04_commit "$S04_UPSTREAM" "" "per Tag freigegebener Stand")"
  s04_signed_tag "$S04_UPSTREAM" trusted v9.9.9 "$tagged"
  OPS_SIGNERS="$S04_DIR/allowed_signers" s04_run_update "$sequence" "$out" || {
    cat "$out" >&2
    test_fail "update rejected a commit released by a signed annotated tag"
  }
  [[ "$(s04_head)" == "$tagged" ]] || test_fail "tag-verified commit was not merged"
  assert_contains "$out" "Signierter Source-Stand bestaetigt: Tag v9.9.9 -> ${tagged:0:12}"
  assert_contains "$sequence" "reexec-updated-operator"
  pass "$desc"
}

test_source_update_rejects_unsigned_commit_before_merge() {
  local desc="outside production an unsigned source target is rejected before merge and operator reload"
  s04_signature_tools_available || { skip_test "$desc" "ssh-keygen fehlt"; return 0; }
  s04_key_fixtures
  local sequence="$TMP_DIR/s04-unsigned.seq" out="$TMP_DIR/s04-unsigned.out" parent unsigned
  local OPS_NODE_ENV=development
  s04_repos unsigned
  # Ein signierter Tag auf dem Vorgaenger sowie leichte/unsignierte Tags auf dem
  # Ziel duerfen das Ziel nicht freigeben.
  parent="$(s04_commit "$S04_UPSTREAM" "" "Vorgaenger")"
  s04_signed_tag "$S04_UPSTREAM" trusted v1.0.0 "$parent"
  unsigned="$(s04_commit "$S04_UPSTREAM" "" "unsignierter Stand")"
  s04_git -C "$S04_UPSTREAM" tag lightweight-on-target "$unsigned"
  s04_git -C "$S04_UPSTREAM" tag -a -m "ohne Signatur" v1.0.1 "$unsigned"

  if OPS_SIGNERS="$S04_DIR/allowed_signers" s04_run_update "$sequence" "$out"; then
    test_fail "update accepted an unsigned source target"
  fi
  [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "rejected source target changed the checkout"
  assert_contains "$out" "Source-Update verweigert: Ziel-Commit $unsigned"
  assert_contains "$out" "Arbeitsbaum und Operator bleiben unveraendert"
  assert_not_contains "$sequence" "reexec-updated-operator"
  assert_not_contains "$sequence" "ensure-host-deps"
  [[ ! -e "$S04_CHECKOUT/.update-handoff" ]] || test_fail "rejected update wrote an operator handoff"

  # Das fruehere Opt-out hebelt konfigurierte Signer nicht aus.
  if OPS_SIGNERS="$S04_DIR/allowed_signers" OPS_OPT_OUT=1 s04_run_update "$sequence" "$out"; then
    test_fail "opt-out overrode configured signers"
  fi
  [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "opt-out with configured signers changed the checkout"
  assert_contains "$out" "TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE ist wirkungslos"
  assert_contains "$out" "Source-Update verweigert: Ziel-Commit $unsigned"

  # Direkter Aufruf der Signaturentscheidung mit konfigurierten Signern.
  if (
    ROOT="$S04_CHECKOUT"
    ENVFILE="$TMP_DIR/s04-no-such.env"
    export GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1
    NODE_ENV=development
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$S04_DIR/allowed_signers"
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=""
    authorize_source_update_target "$S04_BASE" "$unsigned"
  ) >"$out" 2>&1; then
    test_fail "configured signers were not enforced outside production"
  fi
  assert_contains "$out" "Source-Update verweigert"
  pass "$desc"
}

test_source_update_rejects_unknown_signer_despite_ambient_git_config() {
  local desc="unknown SSH keys and forged OpenPGP signatures are rejected even if ambient git config would accept them"
  s04_signature_tools_available || { skip_test "$desc" "ssh-keygen fehlt"; return 0; }
  s04_key_fixtures
  local sequence="$TMP_DIR/s04-rogue.seq" out="$TMP_DIR/s04-rogue.out" rogue hostile="$S04_DIR/hostile-gitconfig"
  local forged tree OPS_NODE_ENV=development
  s04_repos rogue
  rogue="$(s04_commit "$S04_UPSTREAM" rogue "Stand mit fremdem Schluessel")"

  # Eine feindliche globale Git-Konfiguration bestaetigt jede SSH-/OpenPGP-
  # Signatur und vertraut dem Angreifer-Schluessel. Die Pruefung muss alles
  # davon ueberstimmen.
  printf '#!/bin/sh\necho '\''Good "git" signature for trusted@taxtronik.invalid with ED25519 key SHA256:forged'\''\nexit 0\n' \
    >"$S04_DIR/always-good-ssh"
  printf '#!/bin/sh\ncat >/dev/null\nprintf '\''[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG 0123456789ABCDEF Release <trusted@taxtronik.invalid>\\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-01-01 0 4 0 22 8 00 0123456789ABCDEF0123456789ABCDEF01234567\\n[GNUPG:] TRUST_ULTIMATE 0 pgp\\n'\''\nexit 0\n' \
    >"$S04_DIR/always-good-gpg"
  chmod 0700 "$S04_DIR/always-good-ssh" "$S04_DIR/always-good-gpg"
  {
    cat "$S04_DIR/gitconfig"
    printf '[gpg]\n\tprogram = %s\n\tminTrustLevel = undefined\n' "$S04_DIR/always-good-gpg"
    printf '[gpg "ssh"]\n\tprogram = %s\n\tallowedSignersFile = %s\n' "$S04_DIR/always-good-ssh" "$S04_DIR/rogue_signers"
  } >"$hostile"

  if OPS_GITCONFIG="$hostile" OPS_SIGNERS="$S04_DIR/allowed_signers" s04_run_update "$sequence" "$out"; then
    test_fail "update accepted a commit signed by an unknown key"
  fi
  [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "unknown-key target changed the checkout"
  assert_contains "$out" "No principal matched"
  assert_contains "$out" "Source-Update verweigert: Ziel-Commit $rogue"
  assert_not_contains "$sequence" "reexec-updated-operator"

  # Gefaelschter OpenPGP-Commit direkt auf dem installierten Stand.
  tree="$(s04_git -C "$S04_CHECKOUT" rev-parse "HEAD^{tree}")"
  forged="$(printf 'tree %s\nparent %s\nauthor A <a@taxtronik.invalid> 1700000000 +0000\ncommitter A <a@taxtronik.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iHUEABYKAB0WIQQAAAAAAAAAAAAAAAAAAAAAAAAAAAUCZQAAAAAACgkQAAAAAAAA\n -----END PGP SIGNATURE-----\n\nforged\n' \
    "$tree" "$S04_BASE" | s04_git -C "$S04_CHECKOUT" hash-object -t commit -w --stdin)"
  if (
    ROOT="$S04_CHECKOUT"
    ENVFILE="$TMP_DIR/s04-no-such.env"
    export GIT_CONFIG_GLOBAL="$hostile" GIT_CONFIG_NOSYSTEM=1
    NODE_ENV=development
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$S04_DIR/allowed_signers"
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=""
    git -C "$ROOT" verify-commit "$forged" >/dev/null 2>&1 || \
      test_fail "test precondition: ambient gpg should accept the forged commit"
    authorize_source_update_target "$S04_BASE" "$forged"
  ) >"$out" 2>&1; then
    test_fail "forged OpenPGP signature was accepted"
  fi
  assert_contains "$out" "Source-Update verweigert: Ziel-Commit $forged"
  pass "$desc"
}

test_source_update_ignores_signer_files_inside_checkout() {
  local desc="signer files inside the checkout or its repository config never authorize a source update"
  s04_signature_tools_available || { skip_test "$desc" "ssh-keygen fehlt"; return 0; }
  s04_key_fixtures
  local sequence="$TMP_DIR/s04-inside.seq" out="$TMP_DIR/s04-inside.out" rogue path
  local OPS_NODE_ENV=development
  s04_repos inside
  # Der Angreifer liefert seine Signer-Datei im Baum mit und signiert damit.
  cp "$S04_DIR/rogue_signers" "$S04_UPSTREAM/allowed_signers"
  s04_git -C "$S04_UPSTREAM" add allowed_signers
  rogue="$(s04_commit "$S04_UPSTREAM" rogue "liefert eigene Signer mit")"
  # Repo-lokale Git-Konfiguration zeigt auf eine Signer-Datei im Checkout.
  cp "$S04_DIR/rogue_signers" "$S04_CHECKOUT/.git/allowed_signers"
  s04_git -C "$S04_CHECKOUT" config gpg.ssh.allowedSignersFile "$S04_CHECKOUT/.git/allowed_signers"
  ln -s "$S04_CHECKOUT/.git/allowed_signers" "$S04_DIR/signers-link-into-checkout"

  if OPS_SIGNERS="$S04_DIR/allowed_signers" s04_run_update "$sequence" "$out"; then
    test_fail "repository-local signer configuration authorized an update"
  fi
  [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "checkout signer config changed the checkout"
  assert_contains "$out" "No principal matched"

  for path in "$S04_CHECKOUT/.git/allowed_signers" "$S04_DIR/signers-link-into-checkout"; do
    if OPS_SIGNERS="$path" OPS_OPT_OUT=1 s04_run_update "$sequence" "$out"; then
      test_fail "signer file inside the checkout was trusted: $path"
    fi
    [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "in-checkout signer file changed the checkout"
    assert_contains "$out" "liegt im TaxTronik-Checkout und wird ignoriert"
    assert_not_contains "$sequence" "backup-old-checkout"
  done
  pass "$desc"
}

test_source_signer_file_must_be_operator_controlled() {
  local dir out rc
  dir="$(readlink -f "$TMP_DIR")/s04-signer-perms"
  mkdir -p "$dir/safe" "$dir/open"
  printf 'ops@taxtronik.invalid namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n' >"$dir/safe/allowed_signers"
  cp "$dir/safe/allowed_signers" "$dir/open/allowed_signers"
  printf '# nur Kommentar\n\n' >"$dir/safe/empty_signers"
  chmod 0777 "$dir/open"

  out="$(ROOT="$TMP_DIR/s04-other-root" TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$dir/safe/allowed_signers" \
    source_allowed_signers_file)" || test_fail "safe operator-owned signer file was rejected"
  [[ "$out" == "$dir/safe/allowed_signers" ]] || test_fail "signer file was not canonicalized: $out"

  chmod 0666 "$dir/safe/allowed_signers"
  rc=0; out="$(TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$dir/safe/allowed_signers" source_allowed_signers_file)" || rc=$?
  [[ "$rc" == "2" && "$out" == *"fuer Gruppe oder Andere beschreibbar"* ]] || \
    test_fail "world-writable signer file was accepted ($rc: $out)"
  chmod 0600 "$dir/safe/allowed_signers"

  rc=0; out="$(TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$dir/open/allowed_signers" source_allowed_signers_file)" || rc=$?
  [[ "$rc" == "2" && "$out" == *"$dir/open ist fuer Gruppe oder Andere beschreibbar"* ]] || \
    test_fail "signer file in a world-writable directory was accepted ($rc: $out)"

  rc=0; out="$(TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$dir/safe/empty_signers" source_allowed_signers_file)" || rc=$?
  [[ "$rc" == "2" && "$out" == *"enthaelt keinen Signer"* ]] || test_fail "empty signer file was accepted ($rc: $out)"

  rc=0; out="$(TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$dir/missing" source_allowed_signers_file)" || rc=$?
  [[ "$rc" == "2" && "$out" == *"fehlt"* ]] || test_fail "explicitly configured missing signer file counted as unconfigured"

  rc=0
  TAXTRONIK_SOURCE_ALLOWED_SIGNERS="" TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="$dir/absent-default" \
    ENVFILE="$dir/no.env" source_allowed_signers_file >/dev/null || rc=$?
  [[ "$rc" == "1" ]] || test_fail "absent default signer file was not reported as unconfigured ($rc)"
  pass "pinned signer file must be operator-controlled, non-empty and explicitly present"
}

# Produktion nur ueber den Release-Kanal (S-04, Entscheidung C): ein
# Source-Update bricht vor .env-Vorbereitung, Pflichtbackup und Fetch ab, egal
# ob Signer konfiguriert sind oder das fruehere Opt-out gesetzt ist.
test_production_source_update_is_refused_before_backup() {
  local desc="production refuses every source update before env preparation, backup and fetch, with or without signers or opt-out"
  local sequence="$TMP_DIR/s04-prod.seq" out="$TMP_DIR/s04-prod.out" target origin_before signers_dir
  s04_repos production
  target="$(s04_commit "$S04_UPSTREAM" "" "neuer Stand")"
  origin_before="$(s04_git -C "$S04_CHECKOUT" rev-parse origin/main)"
  signers_dir="$(readlink -f "$TMP_DIR")/s04-prod-signers"
  mkdir -p "$signers_dir"
  printf 'ops@taxtronik.invalid namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n' \
    >"$signers_dir/allowed_signers"

  for variant in none signers opt-out; do
    local OPS_SIGNERS="" OPS_OPT_OUT=""
    case "$variant" in
      signers) OPS_SIGNERS="$signers_dir/allowed_signers" ;;
      opt-out) OPS_OPT_OUT=1 ;;
    esac
    if s04_run_update "$sequence" "$out"; then
      test_fail "production accepted a source update ($variant)"
    fi
    assert_contains "$out" "Update verweigert: TAXTRONIK_DEPLOY_CHANNEL=source ist in Produktion nicht zulaessig"
    assert_contains "$out" "TAXTRONIK_DEPLOY_CHANNEL=release"
    assert_contains "$out" "docs/operations/release.md, Abschnitt 2.3"
    assert_contains "$out" "Es wurde nichts veraendert"
    assert_not_contains "$sequence" "prepare-env"
    assert_not_contains "$sequence" "backup-old-checkout"
    assert_not_contains "$sequence" "reexec-updated-operator"
    [[ "$(s04_head)" == "$S04_BASE" ]] || test_fail "refused production update changed the checkout ($variant)"
    [[ "$(s04_git -C "$S04_CHECKOUT" rev-parse origin/main)" == "$origin_before" ]] || \
      test_fail "refused production update fetched the target ($variant): $target"
    [[ ! -e "$S04_CHECKOUT/.update-handoff" ]] || test_fail "refused production update wrote a handoff ($variant)"
    [[ ! -e "$S04_CHECKOUT/.taxtronik.source-update-audit.log" ]] || \
      test_fail "refused production update wrote an unsigned-update record ($variant)"
  done

  # Zweite Sperre: Auch direkt aufgerufen schalten Signer in Produktion nichts frei.
  if (
    ROOT="$S04_CHECKOUT"
    ENVFILE="$TMP_DIR/s04-no-such.env"
    NODE_ENV=production
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS="$signers_dir/allowed_signers"
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=1
    resolve_source_update_trust
  ) >"$out" 2>&1; then
    test_fail "configured signers unlocked a source update in production"
  fi
  assert_contains "$out" "Source-Update in Produktion verweigert, auch mit SSH-signiertem Ziel"
  pass "$desc"
}

# deploy: dieselbe Sperre vor Host-Installation, .env-Vorbereitung, Build,
# Backup und Migration; der Release-Kanal laeuft unveraendert weiter.
test_production_source_deploy_is_refused_before_side_effects() {
  local root="$TMP_DIR/prod-source-deploy" steps="$TMP_DIR/prod-source-deploy.steps"
  local out="$TMP_DIR/prod-source-deploy.out"
  mkdir -p "$root"
  printf 'NODE_ENV=production\nTAXTRONIK_DEPLOY_CHANNEL=source\nTAXTRONIK_IMAGE_PREFIX=taxtronik\n' >"$root/.env"
  run_prod_deploy() (
    ROOT="$root"
    ENVFILE="$root/.env"
    unset NODE_ENV TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX
    configure_initial_deployment_interactive() { printf 'configure\n' >>"$steps"; }
    ensure_bootstrap_host_requirements() { printf 'host-requirements\n' >>"$steps"; }
    prepare_env_interactive() { printf 'env\n' >>"$steps"; }
    load_env() { printf 'load-env\n' >>"$steps"; }
    preflight_common() { :; }
    assert_production_env() { :; }
    require_release_version() { :; }
    assert_no_database_restore_pending() { :; }
    ensure_host_tool_deps() { :; }
    prepare_release_contract() { :; }
    start_infra() { printf 'start-infra\n' >>"$steps"; }
    wait_postgres_healthy() { :; }
    sync_postgres_roles_from_env() { :; }
    provide_images() { printf 'provide-images\n' >>"$steps"; }
    assert_app_env_schema() { printf 'env-check\n' >>"$steps"; }
    provide_traefik_for_deploy() { :; }
    provide_signal_for_deploy() { :; }
    backup_before_migrations() { printf 'backup\n' >>"$steps"; }
    run_migrations() { printf 'migrate\n' >>"$steps"; }
    ensure_provisioned_interactive() { :; }
    ensure_managed_n8n_connection() { :; }
    start_signal_for_deploy() { :; }
    start_apps_for_activation() { printf 'start-apps\n' >>"$steps"; }
    smoke_health() { :; }
    smoke_public_frontend() { :; }
    smoke_client_ip() { printf 'client-ip-smoke\n' >>"$steps"; }
    deploy_readiness() { :; }
    finalize_release_contract() { printf 'finalize\n' >>"$steps"; }
    image_tag() { printf 'test-version'; }
    cmd_deploy
  )

  : >"$steps"
  if run_prod_deploy >"$out" 2>&1; then
    test_fail "production deploy accepted the source channel"
  fi
  assert_file_equals "$steps" "configure"
  assert_contains "$out" "Deploy verweigert: TAXTRONIK_DEPLOY_CHANNEL=source ist in Produktion nicht zulaessig"
  assert_contains "$out" "TAXTRONIK_DEPLOY_CHANNEL=release"

  # Die zweite Sperre in prepare_source_version_for_checkout greift nach
  # load_env auch dann, wenn das Eingangs-Gate nicht durchlaufen wurde.
  if (
    ROOT="$root"
    ENVFILE="$root/.env"
    NODE_ENV=production
    TAXTRONIK_DEPLOY_CHANNEL=source
    prepare_source_version_for_checkout
  ) >"$out" 2>&1; then
    test_fail "source version was prepared for a production build"
  fi
  assert_contains "$out" "Source-Kanal in Produktion verweigert"

  : >"$steps"
  printf 'NODE_ENV=production\nTAXTRONIK_DEPLOY_CHANNEL=release\nTAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik\n' \
    >"$root/.env"
  run_prod_deploy >"$out" 2>&1 || { cat "$out" >&2; test_fail "release-channel deploy was refused"; }
  assert_before "$steps" "configure" "host-requirements"
  assert_before "$steps" "provide-images" "env-check"
  assert_before "$steps" "env-check" "backup"
  assert_before "$steps" "backup" "migrate"
  assert_before "$steps" "start-apps" "client-ip-smoke"
  assert_before "$steps" "client-ip-smoke" "finalize"
  pass "production deploy refuses the source channel before host setup, env preparation, build, backup and migration"
}

# Das fruehere Opt-out entscheidet nichts mehr: kein Audit-Eintrag, keine
# Wertepruefung, nur eine Warnung. Ausserhalb von Produktion bleibt es beim
# unsignierten Warnpfad; in Produktion verweigert das Gate (Test oben).
test_obsolete_source_update_opt_out_has_no_effect() {
  local desc="the former unsigned-update opt-out has no effect and is only reported"
  local sequence="$TMP_DIR/s04-optout.seq" out="$TMP_DIR/s04-optout.out" unsigned
  local OPS_NODE_ENV=development
  s04_repos optout
  unsigned="$(s04_commit "$S04_UPSTREAM" "" "unsignierter Stand")"

  OPS_OPT_OUT=yes s04_run_update "$sequence" "$out" || {
    cat "$out" >&2
    test_fail "an obsolete opt-out value blocked the non-production update"
  }
  [[ "$(s04_head)" == "$unsigned" ]] || test_fail "non-production update did not merge the target"
  assert_contains "$out" "TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE ist wirkungslos und wird ignoriert"
  assert_contains "$out" "Source-Stand $unsigned wird ohne Signaturpruefung uebernommen"
  assert_not_contains "$out" "SICHERHEITS-OPT-OUT"
  assert_not_contains "$out" "darf nur leer, 0 oder 1 sein"
  [[ ! -e "$S04_CHECKOUT/.taxtronik.source-update-audit.log" ]] || \
    test_fail "obsolete opt-out still wrote an unsigned-update record"
  pass "$desc"
}

test_source_update_outside_production_only_warns() {
  local out="$TMP_DIR/s04-nonprod.out" unsigned
  s04_repos nonprod
  unsigned="$(s04_commit "$S04_UPSTREAM" "" "unsignierter Stand")"
  s04_git -C "$S04_CHECKOUT" fetch -q origin
  (
    ROOT="$S04_CHECKOUT"
    ENVFILE="$TMP_DIR/s04-no-such.env"
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="$TMP_DIR/absent-default-allowed-signers"
    export GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1
    NODE_ENV=development
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS=""
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=""
    authorize_source_update_target "$S04_BASE" "$unsigned"
  ) >"$out" 2>&1 || {
    cat "$out" >&2
    test_fail "non-production source update without signers was refused"
  }
  assert_contains "$out" "NODE_ENV=development: Source-Stand $unsigned wird ohne Signaturpruefung uebernommen"

  if (
    ROOT="$S04_CHECKOUT"
    ENVFILE="$TMP_DIR/s04-no-such.env"
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="$TMP_DIR/absent-default-allowed-signers"
    NODE_ENV=production
    TAXTRONIK_SOURCE_ALLOWED_SIGNERS=""
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=""
    resolve_source_update_trust
  ) >"$out" 2>&1; then
    test_fail "the same configuration was accepted in production"
  fi
  assert_contains "$out" "Source-Update in Produktion verweigert"
  assert_contains "$out" "TAXTRONIK_DEPLOY_CHANNEL=release"
  pass "outside production a missing signer configuration only warns"
}

test_source_update_target_ref_is_validated() {
  local commit
  s04_repos refcheck
  for ref in "--upload-pack=evil" "main@{1}" "../main" ""; do
    if ROOT="$S04_CHECKOUT" source_update_target_commit "$ref" >/dev/null 2>&1; then
      test_fail "unsafe update ref was accepted: '$ref'"
    fi
  done
  commit="$(ROOT="$S04_CHECKOUT" GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
    source_update_target_commit origin/main)" || test_fail "valid update ref was rejected"
  [[ "$commit" == "$S04_BASE" ]] || test_fail "update ref resolved to $commit instead of $S04_BASE"
  pass "TAXTRONIK_UPDATE_REF is validated and resolved to one exact commit"
}

test_release_channel_update_ignores_source_signature_gate() {
  local sequence="$TMP_DIR/s04-release.seq" out="$TMP_DIR/s04-release.out"
  : >"$sequence"
  OPS_NODE_ENV=production TAXTRONIK_VERSION=2.0.0 TAXTRONIK_SOURCE_ALLOWED_SIGNERS="" \
    TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE="" OPS_RELEASE_CHANNEL=1 OPS_CHECKOUT_CHANGES=1 \
    OPS_SEQUENCE="$sequence" OPS_MOCK_ROOT="$TMP_DIR/s04-release-root" run_mock_update >"$out" 2>&1 || {
    cat "$out" >&2
    test_fail "release update without source signers failed"
  }
  assert_before "$sequence" "resolve-release-contract" "backup-old-checkout"
  assert_before "$sequence" "backup-old-checkout" "fetch-verified-release-tag 2.0.0 $MOCK_TARGET_COMMIT"
  assert_before "$sequence" "fetch-verified-release-tag" "git merge --ff-only $MOCK_TARGET_COMMIT"
  assert_contains "$sequence" "reexec-updated-operator"
  assert_not_contains "$sequence" "source-trust-ready"
  assert_not_contains "$sequence" "authorize-source-update"
  assert_not_contains "$sequence" "git fetch origin"
  pass "release channel keeps its signed-manifest path and never consults source signers"
}

test_doctor_reports_source_update_signature_state() {
  local env_file="$TMP_DIR/s04-doctor.env" out="$TMP_DIR/s04-doctor.out" signers_dir
  signers_dir="$(readlink -f "$TMP_DIR")/s04-doctor-signers"
  mkdir -p "$signers_dir"
  printf 'ops@taxtronik.invalid namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n' >"$signers_dir/allowed_signers"

  # Produktion: Source-Kanal ist FEHLT mit dem Wechselhinweis des Gates;
  # Signer-Zeilen entfallen, weil Signaturen dort nichts freischalten.
  write_prod_env "$env_file"
  set_env_file_value "$env_file" TAXTRONIK_DEPLOY_CHANNEL source
  set_env_file_value "$env_file" TAXTRONIK_IMAGE_PREFIX taxtronik
  set_env_file_value "$env_file" TAXTRONIK_VERSION source-deadbeef1234
  printf 'TAXTRONIK_SOURCE_ALLOWED_SIGNERS=%s\n' "$signers_dir/allowed_signers" >>"$env_file"
  if run_doctor_with_env "$env_file" "$out"; then
    test_fail "doctor accepted the source channel in production"
  fi
  assert_contains "$out" "FEHLT    TAXTRONIK_DEPLOY_CHANNEL source ist in Produktion nicht zulaessig"
  assert_contains "$out" "Wechsel: in .env TAXTRONIK_DEPLOY_CHANNEL=release"
  assert_contains "$out" "docs/operations/release.md, Abschnitt 2.3"
  assert_not_contains "$out" "SOURCE_UPDATE_SIGNERS"

  # Das fruehere Opt-out ist ueberall wirkungslos: WARN, nie FEHLT, auch mit
  # einem frueher ungueltigen Wert.
  write_prod_env "$env_file"
  printf 'TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE=yes\n' >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || { cat "$out" >&2; test_fail "obsolete opt-out blocked doctor"; }
  assert_contains "$out" "WARN     TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE wirkungslos, entfernen"
  assert_not_contains "$out" "FEHLT"
  assert_not_contains "$out" "SOURCE_UPDATE_SIGNERS"

  # Release-Kanal unveraendert: keine Source-Zeilen, kein Opt-out-Hinweis.
  set_env_file_value "$env_file" TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE ""
  run_doctor_with_env "$env_file" "$out" || { cat "$out" >&2; test_fail "release doctor failed"; }
  assert_contains "$out" "OK       TAXTRONIK_DEPLOY_CHANNEL release (signierte Registry-Artefakte)"
  assert_not_contains "$out" "SOURCE_UPDATE_SIGNERS"
  assert_not_contains "$out" "TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE"

  # Ausserhalb von Produktion bleibt die Signaturanzeige des Source-Kanals
  # (doctor scheitert dort ohnehin an NODE_ENV).
  write_prod_env "$env_file"
  set_env_file_value "$env_file" NODE_ENV development
  set_env_file_value "$env_file" TAXTRONIK_DEPLOY_CHANNEL source
  set_env_file_value "$env_file" TAXTRONIK_IMAGE_PREFIX taxtronik
  set_env_file_value "$env_file" TAXTRONIK_VERSION source-deadbeef1234
  run_doctor_with_env "$env_file" "$out" || true
  assert_contains "$out" "OK       TAXTRONIK_DEPLOY_CHANNEL source (aktueller Git-Stand, lokaler Build)"
  assert_contains "$out" "WARN     SOURCE_UPDATE_SIGNERS  fehlen; ausserhalb Produktion nur Warnung"

  printf 'TAXTRONIK_SOURCE_ALLOWED_SIGNERS=%s\n' "$signers_dir/allowed_signers" >>"$env_file"
  run_doctor_with_env "$env_file" "$out" || true
  if command -v ssh-keygen >/dev/null 2>&1; then
    assert_contains "$out" "OK       SOURCE_UPDATE_SIGNERS  $signers_dir/allowed_signers (SSH-Signatur vor jedem Update Pflicht)"
  else
    assert_contains "$out" "WARN     SOURCE_UPDATE_SIGNERS  $signers_dir/allowed_signers, aber ssh-keygen fehlt"
  fi

  set_env_file_value "$env_file" TAXTRONIK_SOURCE_ALLOWED_SIGNERS "$REPO_ROOT/README.md"
  run_doctor_with_env "$env_file" "$out" || true
  assert_contains "$out" "FEHLT    SOURCE_UPDATE_SIGNERS  $REPO_ROOT/README.md liegt im TaxTronik-Checkout und wird ignoriert"
  pass "doctor refuses the source channel in production and shows signer rows only outside it"
}

test_managed_signal_source_build_pins_commits_and_flags_moving_refs() {
  local origin="$TMP_DIR/signal-pin-origin" checkout="$TMP_DIR/signal-pin-checkout"
  local build_root="$TMP_DIR/signal-pin-build-root" out="$TMP_DIR/signal-pin.out" first second
  s04_git_fixtures
  mkdir -p "$origin/scripts" "$build_root"
  s04_git -C "$origin" init -q -b main
  printf 'first\n' >"$origin/README.md"
  printf '#!/bin/sh\nexit 0\n' >"$origin/scripts/build-managed-image.sh"
  s04_git -C "$origin" add README.md scripts/build-managed-image.sh
  s04_git -C "$origin" commit -qm first
  first="$(s04_git -C "$origin" rev-parse HEAD)"
  printf 'second\n' >"$origin/README.md"
  s04_git -C "$origin" commit -qam second
  second="$(s04_git -C "$origin" rev-parse HEAD)"

  run_signal_pin_build() (
    ROOT="$build_root"
    export GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1
    SIGNAL_GIT_URL="$origin"
    SIGNAL_GIT_REF="$1"
    SIGNAL_GIT_DIR="$checkout"
    SIGNAL_IMAGE=""
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    docker() { return 1; }
    build_signal_from_source update
    printf 'image=%s\n' "$SIGNAL_IMAGE"
  )

  run_signal_pin_build "$first" >"$out" 2>&1 || { cat "$out" >&2; test_fail "pinned Signal commit build failed"; }
  assert_contains "$out" "image=taxtronik/risk-layer-engine:source-${first:0:12}"
  assert_not_contains "$out" "ist beweglich"
  assert_file_equals "$checkout/README.md" "first"

  run_signal_pin_build main >"$out" 2>&1 || { cat "$out" >&2; test_fail "moving Signal ref build failed"; }
  assert_contains "$out" "SIGNAL_GIT_REF 'main' ist beweglich; gebaut wird der aktuelle Stand ${second:0:12}"
  assert_contains "$out" "image=taxtronik/risk-layer-engine:source-${second:0:12}"

  if run_signal_pin_build "" >"$out" 2>&1; then
    test_fail "Signal source build ran without an explicit Git ref"
  fi
  assert_contains "$out" "SIGNAL_GIT_REF fehlt oder ist ungueltig"
  pass "managed Signal builds exactly a pinned commit and warns for moving refs"
}

# B-05-Nacharbeit: Kann der Signal-Checkout nicht geprueft werden (Git-Status
# oder Verzeichnislesen scheitert), wird nicht gebaut. Frueher galt ein
# gescheitertes `git status` als sauber und ein gescheitertes `find` als leerer
# Arbeitsbaum, der die Pruefung auf lokale Aenderungen uebersprang.
test_signal_checkout_inspection_errors_stop_the_build() {
  local origin="$TMP_DIR/signal-inspect-origin" checkout="$TMP_DIR/signal-inspect-checkout"
  local fresh="$TMP_DIR/signal-inspect-fresh" build_root="$TMP_DIR/signal-inspect-build-root"
  local out="$TMP_DIR/signal-inspect.out" marker="$TMP_DIR/signal-inspect.built"
  s04_git_fixtures
  mkdir -p "$origin/scripts" "$build_root"
  s04_git -C "$origin" init -q -b main
  printf 'signal\n' >"$origin/README.md"
  printf '#!/bin/sh\n: >"%s"\n' "$marker" >"$origin/scripts/build-managed-image.sh"
  s04_git -C "$origin" add README.md scripts/build-managed-image.sh
  s04_git -C "$origin" commit -qm first
  s04_git clone -q "$origin" "$checkout"

  run_inspect_build() (
    ROOT="$build_root"
    export GIT_CONFIG_GLOBAL="$S04_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1
    SIGNAL_GIT_URL="$origin"
    SIGNAL_GIT_REF=main
    SIGNAL_GIT_DIR="$1"
    valid_signal_git_url() { return 0; }
    require_safe_build_resources() { return 0; }
    docker() { return 1; }
    git() {
      if [[ "$*" == *" status --porcelain"* && "${INSPECT_FAIL:-}" == status ]]; then
        printf 'fatal: index file corrupt\n' >&2
        return 128
      fi
      command git "$@"
    }
    find() {
      if [[ "${INSPECT_FAIL:-}" == find ]]; then
        printf "find: '%s': Permission denied\n" "$1" >&2
        return 1
      fi
      command find "$@"
    }
    build_signal_from_source
  )

  # Bestehender Checkout: Status vor dem Fetch nicht ermittelbar.
  rm -f -- "$marker"
  if INSPECT_FAIL=status run_inspect_build "$checkout" >"$out" 2>&1; then
    test_fail "Signal build continued without a checkout status"
  fi
  assert_contains "$out" "fatal: index file corrupt"
  assert_contains "$out" "Status des Signal-Checkouts nicht ermittelbar"
  [[ ! -e "$marker" ]] || test_fail "Signal was built from an unchecked checkout"

  # Bestehender Checkout mit lokaler Datei: unlesbares Verzeichnis ist kein
  # leerer Arbeitsbaum; vor Fetch und Checkout wird abgebrochen.
  printf 'operator-owned file\n' >"$checkout/local-note.txt"
  if INSPECT_FAIL=find run_inspect_build "$checkout" >"$out" 2>&1; then
    test_fail "Signal build continued with an unreadable checkout"
  fi
  assert_contains "$out" "Permission denied"
  assert_contains "$out" "nicht vollstaendig lesbar"
  [[ "$(s04_git -C "$checkout" symbolic-ref -q HEAD || true)" == "refs/heads/main" ]] || \
    test_fail "unreadable Signal checkout was switched before the refusal"
  [[ ! -e "$marker" ]] || test_fail "Signal was built from an unreadable checkout"
  rm -f -- "$checkout/local-note.txt"

  # Frischer Klon: Status nach dem kontrollierten Checkout nicht ermittelbar.
  if INSPECT_FAIL=status run_inspect_build "$fresh" >"$out" 2>&1; then
    test_fail "Signal build continued without a post-checkout status"
  fi
  assert_contains "$out" "Status des Signal-Checkouts nach dem Checkout nicht ermittelbar"
  [[ ! -e "$marker" ]] || test_fail "Signal was built from an unverified fresh checkout"

  run_inspect_build "$checkout" >"$out" 2>&1 || { cat "$out" >&2; test_fail "clean Signal build failed"; }
  [[ -e "$marker" ]] || test_fail "clean Signal checkout was not built"
  pass "Signal source build stops when the checkout status or contents cannot be read"
}

# B-05-Nacharbeit: Scheitert nach einem fehlgeschlagenen Rollback das
# Zuruecksetzen des Checkouts, startet die Recovery keine Last-Good-Container aus
# dem fremden Checkout (frueher still per 2>/dev/null) und stoppt nur bereits
# gestartete Writer des gescheiterten Ziels.
test_rollback_recovery_never_starts_last_good_from_a_foreign_checkout() {
  local out="$TMP_DIR/rollback-recover.out" calls="$TMP_DIR/rollback-recover.calls" rc
  run_recover() (
    _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED=1
    _TAXTRONIK_ROLLBACK_LAST_GOOD_COMMIT="$(printf 'b%.0s' {1..40})"
    _TAXTRONIK_ROLLBACK_SOURCE_COMMIT="$(printf 'c%.0s' {1..40})"
    _TAXTRONIK_ROLLBACK_SOURCE_BRANCH=""
    _TAXTRONIK_ROLLBACK_LAST_GOOD_VERSION=2.0.0
    _TAXTRONIK_ROLLBACK_WRITERS_STARTED="${RECOVER_WRITERS:-1}"
    git() {
      printf 'git %s\n' "$*" >>"$calls"
      [[ "${RECOVER_GIT:-fail}" == ok ]] && return 0
      printf 'error: Your local changes to the following files would be overwritten by checkout\n' >&2
      return 1
    }
    start_apps_for_activation() { printf 'start-apps %s\n' "$*" >>"$calls"; }
    compose() { printf 'compose %s\n' "$*" >>"$calls"; }
    rollback_failure_recover 7
  )

  : >"$calls"; rc=0
  run_recover >"$out" 2>&1 || rc=$?
  [[ "$rc" == "7" ]] || test_fail "recovery changed the exit code to $rc"
  assert_contains "$out" "would be overwritten by checkout"
  assert_contains "$out" "konnte nicht wiederhergestellt werden"
  assert_contains "$out" "Manuell: git -C $ROOT switch --detach"
  assert_not_contains "$calls" "start-apps"
  assert_contains "$calls" "compose stop app worker n8n"

  # Vor der Aktivierung laufen noch die Last-Good-Container: nichts stoppen.
  : >"$calls"; rc=0
  RECOVER_WRITERS=0 run_recover >"$out" 2>&1 || rc=$?
  [[ "$rc" == "7" ]] || test_fail "recovery changed the exit code to $rc"
  assert_not_contains "$calls" "start-apps"
  assert_not_contains "$calls" "compose stop"

  # Erfolgreich zurueckgesetzt: Last-Good-Container wie bisher starten.
  : >"$calls"; rc=0
  RECOVER_GIT=ok run_recover >"$out" 2>&1 || rc=$?
  [[ "$rc" == "7" ]] || test_fail "recovery changed the exit code to $rc"
  assert_contains "$calls" "start-apps rollback 2.0.0"
  pass "rollback recovery never starts last-good containers from a checkout it could not restore"
}

test_signal_source_ref_has_no_implicit_moving_default() {
  local env_file="$TMP_DIR/signal-ref-default.env" out="$TMP_DIR/signal-ref-default.out" sha
  [[ -z "$SIGNAL_GIT_REF_DEFAULT" ]] || test_fail "SIGNAL_GIT_REF_DEFAULT still selects '$SIGNAL_GIT_REF_DEFAULT'"
  [[ "$(grep -E '^SIGNAL_GIT_REF=' "$REPO_ROOT/.env.example" | tr -d '\r')" == "SIGNAL_GIT_REF=" ]] || \
    test_fail ".env.example still presets a Signal Git ref"

  : >"$env_file"
  if (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT=managed
    SIGNAL_DEPLOY_CHANNEL=source
    SIGNAL_GIT_URL=https://git.example/taxtronik/signal.git
    SIGNAL_GIT_REF=""
    SIGNAL_GIT_DIR=/opt/signal
    SIGNAL_LLM_DIR="$TMP_DIR/signal-ref-default-llm"
    configure_risk_layer_interactive
  ) </dev/null >"$out" 2>&1; then
    test_fail "managed Signal source setup silently chose a Git ref"
  fi
  assert_contains "$out" "SIGNAL_GIT_REF fehlt oder ist ungueltig"
  assert_not_contains "$env_file" "SIGNAL_GIT_REF=main"

  sha="$(printf 'b%.0s' {1..40})"
  (
    ENVFILE="$env_file"
    SIGNAL_DEPLOYMENT=managed
    SIGNAL_DEPLOY_CHANNEL=source
    SIGNAL_GIT_URL=https://git.example/taxtronik/signal.git
    SIGNAL_GIT_REF="$sha"
    SIGNAL_GIT_DIR=/opt/signal
    SIGNAL_LLM_DIR="$TMP_DIR/signal-ref-default-llm"
    configure_risk_layer_interactive
  ) </dev/null >"$out" 2>&1 || { cat "$out" >&2; test_fail "pinned Signal commit was rejected by setup"; }
  assert_key_equals "$env_file" SIGNAL_GIT_REF "$sha"
  pass "managed Signal source has no implicit moving default ref"
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

test_verified_non_migration_retarget_requires_exact_forward_state() {
  local source_commit old_target_commit new_target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"

  (
    git() { [[ "$*" == *"merge-base --is-ancestor $old_target_commit $new_target_commit"* ]]; }
    database_is_fully_migrated_for_commit() { [[ "$1" == "$old_target_commit" ]]; }
    can_retarget_verified_non_migration_transition \
      source-bbbbbbbbbbbb "$source_commit" \
      source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" \
      source-dddddddddddd "$new_target_commit" false
  ) || test_fail "verified migrations-free descendant was rejected"

  (
    git() { return 0; }
    database_is_fully_migrated_for_commit() { return 0; }
    can_retarget_verified_non_migration_transition \
      source-bbbbbbbbbbbb "$source_commit" \
      source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" \
      source-dddddddddddd "$new_target_commit" unknown
  ) || test_fail "migration-free Git tree could not resolve an unknown historical probe"

  if (
    git() {
      [[ "$*" != *"diff --quiet $source_commit $old_target_commit"* ]]
    }
    database_is_fully_migrated_for_commit() { return 0; }
    can_retarget_verified_non_migration_transition \
      source-bbbbbbbbbbbb "$source_commit" \
      source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" \
      source-dddddddddddd "$new_target_commit" unknown
  ); then
    test_fail "unknown migration requirement with changed migration tree was retargeted"
  fi

  if (
    git() { return 0; }
    database_is_fully_migrated_for_commit() { return 1; }
    can_retarget_verified_non_migration_transition \
      source-bbbbbbbbbbbb "$source_commit" \
      source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" \
      source-dddddddddddd "$new_target_commit" false
  ); then
    test_fail "incompletely migrated old target was retargeted"
  fi

  if (
    git() { return 0; }
    database_is_fully_migrated_for_commit() { return 0; }
    can_retarget_verified_non_migration_transition \
      source-bbbbbbbbbbbb "$source_commit" \
      source-cccccccccccc "$old_target_commit" \
      source-bbbbbbbbbbbb "$source_commit" \
      source-eeeeeeeeeeee "$new_target_commit" false
  ); then
    test_fail "source version not bound to its commit was retargeted"
  fi

  pass "migrations-free pending retarget requires exact Git, ancestry, version and database state"
}

test_migration_transition_retargets_verified_non_migration_descendant() {
  local state_file="$TMP_DIR/transition-non-migration.state"
  local marker="$TMP_DIR/transition-non-migration.pending"
  local out="$TMP_DIR/transition-non-migration.out"
  local source_commit old_target_commit new_target_commit
  source_commit="$(printf 'b%.0s' {1..40})"
  old_target_commit="$(printf 'c%.0s' {1..40})"
  new_target_commit="$(printf 'd%.0s' {1..40})"
  cat >"$state_file" <<EOF
current=source-bbbbbbbbbbbb
current_commit=$source_commit
current_rollback_requires_db_restore=false
EOF
  cat >"$marker" <<EOF
source_version=source-bbbbbbbbbbbb
source_commit=$source_commit
target_version=source-cccccccccccc
target_commit=$old_target_commit
requires_db_restore=false
EOF

  (
    STATE="$state_file"
    MIGRATION_PENDING="$marker"
    DB_RESTORE_AUTHORIZATION="$TMP_DIR/transition-non-migration.no-restore"
    TAXTRONIK_VERSION=source-dddddddddddd
    TAXTRONIK_RELEASE_COMMIT="$new_target_commit"
    pending_database_migration_requirement() { printf 'true'; }
    can_retarget_verified_non_migration_transition() { return 0; }
    can_retarget_recoverable_gwg_034_transition() {
      test_fail "GwG special recovery was used for a migrations-free transition"
    }
    begin_migration_transition
  ) >"$out" 2>&1

  assert_key_equals "$marker" source_version source-bbbbbbbbbbbb
  assert_key_equals "$marker" source_commit "$source_commit"
  assert_key_equals "$marker" target_version source-dddddddddddd
  assert_key_equals "$marker" target_commit "$new_target_commit"
  assert_key_equals "$marker" requires_db_restore true
  assert_contains "$out" "migrationsfreien Fehlerzustand"
  pass "verified migrations-free activation failure advances to a descendant without weakening restore"
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
  local old_target_commit calls="$TMP_DIR/gwg-034-resolution.calls"
  old_target_commit="$(printf 'c%.0s' {1..40})"

  if (
    GWG_CALLS="$calls"
    # Simuliert `prisma migrate resolve --applied`, ohne die 034-DDL
    # tatsaechlich ausgefuehrt zu haben: Die versionierte Pruefung meldet die
    # fehlende Vernichtungsfunktion.
    GWG_ANSWER_034='gwg_034.function:app.destroy_gwg_check(uuid)'
    git() { printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction; }
    compose() {
      if [[ "$*" == *"finished_at IS NULL"* ]]; then
        printf 'no'
      elif [[ "$*" == *"SELECT migration_name"* ]]; then
        printf '%s\n' 20260801003400_gwg_fail_closed_and_destruction
      else
        fake_gwg_invariant_psql "$@"
      fi
    }
    database_is_fully_migrated_for_commit "$old_target_commit"
  ) >/dev/null 2>&1; then
    test_fail "finished GwG 034 journal without schema invariants was accepted"
  fi
  assert_file_equals "$calls" "034-fail-closed-and-destruction.sql"

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
  local file="$GWG_INVARIANT_DIR/043-identity-subjects-and-document-sets.sql"
  local calls="$TMP_DIR/gwg-identity.calls" out="$TMP_DIR/gwg-identity.out" status=0

  # Inhalt der versionierten Datei; gegen die echte DB laeuft sie in
  # packages/db/src/__tests__/db-invariants.test.ts und im CI-Pruefer.
  assert_contains "$file" "identity_assignment_required"
  assert_contains "$file" "document_set_id"
  assert_contains "$file" "natural_client_subject_id"
  assert_contains "$file" "beneficial_owner_subject_id"
  assert_contains "$file" "representative_subject_id"
  assert_contains "$file" "identity_assignment_confirmed_at"
  assert_contains "$file" "identity_assignment_confirmed_by"
  assert_contains "$file" "public.gwg_representative"
  assert_contains "$file" "app.guard_gwg_id_document_subject_and_set()"
  assert_contains "$file" "app.enforce_gwg_document_set_consistency()"
  assert_contains "$file" "app.gwg_check_has_confirmed_identity(uuid)"
  assert_contains "$file" "app.enforce_gwg_identity_assignment_on_verification()"
  assert_contains "$file" "app.invalidate_gwg_beneficial_owner_identity_assignment()"
  assert_contains "$file" "gwg_id_document_subject_and_set_guard"
  assert_contains "$file" "gwg_document_set_consistency"
  assert_contains "$file" "00_gwg_check_identity_verification_guard"
  assert_contains "$file" "gwg_beneficial_owner_identity_assignment_invalidate"

  (
    GWG_CALLS="$calls"
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_identity_invariants
  ) || test_fail "complete GwG identity invariant probe was rejected"
  assert_file_equals "$calls" "043-identity-subjects-and-document-sets.sql"

  (
    GWG_ANSWER_043='gwg_043.forced_rls:gwg_representative'
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_identity_invariants
  ) >"$out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || test_fail "GwG identity violation must return 1, got $status"
  assert_contains "$out" "GwG-Invariante verletzt (043-identity-subjects-and-document-sets.sql)"
  assert_contains "$out" "gwg_043.forced_rls:gwg_representative"

  pass "GwG identity invariant contract covers schema, functions and active guards"
}

test_gwg_044_invariant_requires_immutable_evidence_versions() {
  local file="$GWG_INVARIANT_DIR/044-legacy-guard-recovery.sql"
  local calls="$TMP_DIR/gwg-044.calls" out="$TMP_DIR/gwg-044.out" status=0

  assert_contains "$file" "app.block_version_during_gwg_destruction()"
  assert_contains "$file" "public.\"gwg_id_document\""
  assert_contains "$file" "app.gwg_destroy_document_id"
  assert_contains "$file" "authorized_delete"
  assert_contains "$file" "FOR UPDATE"
  assert_contains "$file" "document_version_block_gwg_destruction"

  (
    GWG_CALLS="$calls"
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_044_invariants
  ) || test_fail "complete GwG 044 invariant probe was rejected"
  assert_file_equals "$calls" "044-legacy-guard-recovery.sql"

  (
    GWG_ANSWER_044='gwg_044.function_body:app.block_version_during_gwg_destruction().document_row_lock'
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_044_invariants
  ) >"$out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || test_fail "GwG 044 violation must return 1, got $status"
  assert_contains "$out" "gwg_044.function_body:app.block_version_during_gwg_destruction().document_row_lock"

  pass "GwG 044 invariant requires immutable assigned evidence versions"
}

test_manual_gwg_identity_resolution_requires_schema_invariants() {
  local target_commit calls="$TMP_DIR/gwg-identity-resolution.calls"
  target_commit="$(printf 'c%.0s' {1..40})"

  if (
    GWG_ANSWER_043='gwg_043.table:gwg_representative'
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
      else
        fake_gwg_invariant_psql "$@"
      fi
    }
    database_is_fully_migrated_for_commit "$target_commit"
  ) >/dev/null 2>&1; then
    test_fail "finished GwG 043/044 journal without identity schema invariants was accepted"
  fi

  (
    GWG_CALLS="$calls"
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
      else
        fake_gwg_invariant_psql "$@"
      fi
    }
    database_is_fully_migrated_for_commit "$target_commit"
  ) || test_fail "complete GwG 043/044 schema invariants were rejected"
  assert_file_equals "$calls" $'034-fail-closed-and-destruction.sql\n043-identity-subjects-and-document-sets.sql\n044-legacy-guard-recovery.sql'

  pass "manual GwG 043/044 resolution requires the real identity protection schema"
}

test_gwg_invariants_are_versioned_single_source() {
  local file name
  # Jede versionierte Datei ist im Deploy-Gate verdrahtet und umgekehrt; CI
  # prueft genau diese Dateien mit packages/db/scripts/check-db-invariants.mjs.
  for file in "$GWG_INVARIANT_DIR"/*.sql; do
    name="${file##*/}"
    grep -Fq "=\"$name\"" "$OPS_SOURCES" || \
      test_fail "versioned GwG invariant $name is not wired into ops-lib.sh"
  done
  for name in "$GWG_INVARIANTS_034" "$GWG_INVARIANTS_IDENTITY" "$GWG_INVARIANTS_044"; do
    [[ -f "$GWG_INVARIANT_DIR/$name" ]] || test_fail "ops-lib.sh references missing invariant $name"
  done
  # Kein zweiter, eingebetteter SQL-Stand der Invarianten im Operator.
  for name in gwg_check_no_hard_delete gwg_representative_isolation \
              gwg_document_set_consistency authorized_delete; do
    grep -Fq -- "$name" "$GWG_INVARIANT_DIR"/*.sql || \
      test_fail "versioned GwG invariants no longer check $name"
    assert_not_contains "$OPS_SOURCES" "$name"
  done
  pass "GwG invariants live only in versioned SQL files wired into the deploy gate"
}

test_gwg_invariant_sql_error_is_not_reported_as_violation() {
  local out="$TMP_DIR/gwg-sql-error.out" status=0

  (
    GWG_ANSWER_034=ERROR
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_invariants_for_checkout
  ) >"$out" 2>&1 || status=$?
  [[ "$status" == 2 ]] || test_fail "GwG SQL error must return 2, got $status"
  assert_contains "$out" "GwG-Invariantenpruefung 034-fail-closed-and-destruction.sql: SQL-/Verbindungsfehler (Exit 3)"
  assert_contains "$out" 'relation "information_schema.columns" does not exist'
  assert_not_contains "$out" "GwG-Invariante verletzt"

  status=0
  (
    compose() { printf 'service "postgres" is not running\n' >&2; return 1; }
    database_has_gwg_invariants_for_checkout
  ) >"$out" 2>&1 || status=$?
  [[ "$status" == 2 ]] || test_fail "unreachable postgres must return 2, got $status"
  assert_contains "$out" 'service "postgres" is not running'
  assert_not_contains "$out" "GwG-Invariante verletzt"

  status=0
  (
    GWG_ANSWER_034=EMPTY_ROW
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_invariants_for_checkout
  ) >"$out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || test_fail "an unnamed violation row must never count as success, got $status"
  assert_contains "$out" "<Verletzung ohne Namen>"

  pass "GwG invariant SQL errors are reported as such and never count as success"
}

gwg_binding_root() {
  local root="$TMP_DIR/gwg-binding-$1" migration
  shift
  mkdir -p "$root/packages/db/prisma/migrations" "$root/packages/db/invariants"
  cp -R "$GWG_INVARIANT_DIR" "$root/packages/db/invariants/"
  for migration in "$@"; do mkdir -p "$root/packages/db/prisma/migrations/$migration"; done
  printf '%s' "$root"
}

assert_gwg_binding() {
  local name="$1" expected="$2" root calls="$TMP_DIR/gwg-binding-$1.calls"
  shift 2
  root="$(gwg_binding_root "$name" "$@")"
  (
    ROOT="$root"
    GWG_CALLS="$calls"
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_invariants_for_checkout
  ) || test_fail "GwG binding $name rejected a complete protection schema"
  assert_file_equals "$calls" "$expected"
}

test_gwg_invariants_keep_migration_presence_conditions() {
  local f034=034-fail-closed-and-destruction.sql
  local f043=043-identity-subjects-and-document-sets.sql
  local f044=044-legacy-guard-recovery.sql
  local m034=20260801003400_gwg_fail_closed_and_destruction
  local m043=20260801004300_gwg_identity_subjects_and_document_sets
  local m044=20260801004400_legacy_gwg_guard_recovery
  local root calls="$TMP_DIR/gwg-binding-stop.calls" status=0

  assert_gwg_binding pre-gwg ""
  assert_gwg_binding only-034 "$f034" "$m034"
  assert_gwg_binding only-043 "$f043" "$m043"
  assert_gwg_binding 034-043 "$f034"$'\n'"$f043" "$m034" "$m043"
  assert_gwg_binding recovery-044 "$f034"$'\n'"$f043"$'\n'"$f044" "$m044"

  # Die erste nicht erfuellte Pruefung beendet den Lauf und bestimmt den Status.
  root="$(gwg_binding_root stop "$m034" "$m043" "$m044")"
  (
    ROOT="$root"
    GWG_CALLS="$calls"
    GWG_ANSWER_034='gwg_034.trigger:gwg_check.gwg_check_no_hard_delete'
    compose() { fake_gwg_invariant_psql "$@"; }
    database_has_gwg_invariants_for_checkout
  ) >/dev/null 2>&1 || status=$?
  [[ "$status" == 1 ]] || test_fail "first violated GwG invariant must return 1, got $status"
  assert_file_equals "$calls" "$f034"

  pass "GwG invariant files keep the migration-presence binding of the checkout"
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
      else
        fake_gwg_invariant_psql "$@"
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

test_ensure_secret_reports_known_dev_defaults() {
  local env_file="$TMP_DIR/weak-defaults.env" out="$TMP_DIR/weak-defaults.out"
  printf 'N8N_HMAC_SECRET=dev-only-hmac-secret-min-32-chars-long-xxx\nAUTH_SECRET=\n' >"$env_file"
  (
    ENVFILE="$env_file"
    ensure_secret N8N_HMAC_SECRET 32
    ensure_secret AUTH_SECRET 32
  ) >"$out" 2>&1
  assert_contains "$out" "N8N_HMAC_SECRET ist ein bekannter Dev-/CI-Default"
  assert_contains "$out" "AUTH_SECRET generiert."
  assert_key_equals "$env_file" N8N_HMAC_SECRET dev-only-hmac-secret-min-32-chars-long-xxx
  [[ "$(grep -E '^AUTH_SECRET=' "$env_file" | cut -d= -f2-)" =~ ^[A-Za-z0-9_-]{43}$ ]] || \
    test_fail "empty AUTH_SECRET was not generated"
  pass "ensure_secret fills empty secrets and reports known dev defaults without rotating them"
}

run_test test_doctor_accepts_prod_smtp
run_test test_doctor_checks_db_pool_sum_against_max_connections
run_test test_doctor_fix_provisions_db_role_secrets
run_test test_doctor_requires_distinct_db_role_secrets
run_test test_doctor_rejects_superuser_in_container_db_urls
run_test test_doctor_reports_live_db_role_state
run_test test_sync_postgres_roles_provisions_owner_and_drill_roles
run_test test_doctor_rejects_mailhog
run_test test_doctor_rejects_loopback_mailhog_port
run_test test_doctor_leaves_schema_only_rules_to_the_target_image
run_test test_doctor_accepts_complete_traefik_contract
run_test test_doctor_rejects_unsafe_traefik_proxy_trust
run_test test_doctor_warns_without_proxy_trust
run_test test_doctor_requires_32_char_app_secrets_without_rotation
run_test test_doctor_requires_n8n_hmac_secret_only_when_needed
run_test test_doctor_requires_https_public_urls
run_test test_one_sided_cookie_domains_only_warn
run_test test_doctor_rejects_n8n_on_an_application_domain
run_test test_env_read_errors_never_look_like_missing_values
run_test test_source_version_is_never_written_empty
run_test test_initial_setup_confirmation_and_atomic_plan_application
run_test test_setup_asks_for_client_ip_trust
run_test test_client_ip_smoke_verdicts
run_test test_deploy_provisions_managed_n8n_in_acp
run_test test_one_click_blank_host_guard_rejects_existing_containers
run_test test_one_click_blank_host_guard_rejects_unreachable_docker
run_test test_one_click_blank_host_allows_missing_docker_for_deferred_install
run_test test_source_channel_derives_version_from_checkout_without_semver
run_test test_source_version_without_head_stops_immediately
run_test test_deployment_channel_is_explicit_with_legacy_prefix_fallback
run_test test_cli_presents_deploy_as_primary_path
run_test test_bootstrap_installs_one_click_requirements_after_configuration
run_test test_existing_one_click_deploy_does_not_reapply_blank_host_gate
run_test test_interrupted_one_click_deploy_resumes_only_owned_containers
run_test test_interrupted_one_click_deploy_still_rejects_foreign_containers
run_test test_one_click_runtime_install_contract_is_pinned_and_official
run_test test_one_click_replaces_incomplete_docker_only_after_blank_host_gate
run_test test_one_click_installs_openssh_client
run_test test_traefik_dynamic_route_and_compose_contract_are_socketless
run_test test_traefik_lifecycle_is_part_of_activation
run_test test_full_backup_snapshots_managed_traefik_acme_volume
run_test test_doctor_accepts_internal_risk_layer_without_fetch_allowlist
run_test test_doctor_shows_target_image_schema_rows
run_test test_doctor_warns_for_missing_risk_layer_operator_token_without_failing
run_test test_doctor_accepts_self_contained_managed_signal
run_test test_doctor_rejects_managed_signal_latest_image
run_test test_doctor_accepts_managed_signal_source_checkout
run_test test_signal_source_identifiers_are_shell_safe_and_secret_free
run_test test_app_env_check_runs_in_the_target_worker_image
run_test test_deploy_checks_app_env_schema_before_backup_and_migration
run_test test_doctor_rejects_signal_values_when_disabled
run_test test_configure_risk_layer_generates_operator_token
run_test test_configure_external_risk_layer_stays_read_only_without_coordinated_token
run_test test_managed_signal_requires_distinct_generated_tokens
run_test test_external_signal_lifecycle_never_touches_docker
run_test test_legacy_native_signal_is_inferred_as_external
run_test test_managed_signal_lifecycle_uses_pinned_release
run_test test_managed_signal_source_build_skips_registry_pull
run_test test_managed_signal_source_build_accepts_fresh_no_checkout_clone
run_test test_managed_signal_source_update_skips_unchanged_image_unless_requested
run_test test_managed_signal_source_update_honors_interactive_rebuild_choice
run_test test_managed_signal_source_build_pins_commits_and_flags_moving_refs
run_test test_signal_source_ref_has_no_implicit_moving_default
run_test test_signal_checkout_inspection_errors_stop_the_build
run_test test_rollback_recovery_never_starts_last_good_from_a_foreign_checkout
run_test test_signal_embedding_compose_contract_is_self_contained_and_offline
run_test test_hardware_aaguid_allowlist_is_forwarded_to_app
run_test test_hardware_aaguid_allowlist_is_forwarded_to_worker
run_test test_trust_proxy_hops_is_forwarded_to_app
run_test test_windows_signal_dev_start_provisions_embedding_operator
run_test test_prune_build_cache_calls_docker_builder_prune
run_test test_prune_build_cache_can_be_disabled
run_test test_prune_build_cache_failure_is_non_blocking
run_test test_build_images_enforces_hard_memory_and_swap_limit
run_test test_build_images_refuses_insufficient_host_memory
run_test test_build_images_refuses_unsafe_legacy_buildx
run_test test_restore_source_detection_uses_s3_for_bucket_sources
run_test test_restore_source_detection_skips_s3_for_local_file
run_test test_restore_validation_requires_explicit_target
run_test test_restore_validation_rejects_unknown_and_conflicting_args
run_test test_restore_list_does_not_change_service_state
run_test test_production_restore_requires_exact_confirmation_before_side_effects
run_test test_production_restore_stops_writers_and_leaves_them_stopped
run_test test_failed_production_restore_also_leaves_writers_stopped
run_test test_isolated_restore_does_not_stop_production_writers
run_test test_smoke_health_rejects_degraded
run_test test_deploy_readiness_rejects_missing_hostports
run_test test_deploy_readiness_rejects_gwg_schema_drift
run_test test_deploy_readiness_reports_gwg_sql_error_separately
run_test test_run_migrations_blocks_incomplete_gwg_schema_before_writer_start
run_test test_run_migrations_reports_gwg_sql_error_before_writer_start
run_test test_pre_migration_backup_requires_a_proven_first_deploy
run_test test_backup_manifest_detects_tampering
run_test test_host_tool_deps_refresh_stale_checkout
run_test test_run_backup_uses_resolved_host_path
run_test test_run_backup_respects_explicit_staging_path
run_test test_update_backs_up_old_checkout_before_fetch
run_test test_update_schema_error_stops_before_migration
run_test test_update_backup_failure_leaves_checkout_untouched
run_test test_changed_update_reloads_operator_and_resumes_same_run
run_test test_invalid_update_handoff_restarts_with_backup
run_test test_source_update_accepts_signed_commit_and_signed_tag
run_test test_source_update_rejects_unsigned_commit_before_merge
run_test test_source_update_rejects_unknown_signer_despite_ambient_git_config
run_test test_source_update_ignores_signer_files_inside_checkout
run_test test_source_signer_file_must_be_operator_controlled
run_test test_production_source_update_is_refused_before_backup
run_test test_production_source_deploy_is_refused_before_side_effects
run_test test_obsolete_source_update_opt_out_has_no_effect
run_test test_source_update_outside_production_only_warns
run_test test_source_update_target_ref_is_validated
run_test test_release_channel_update_ignores_source_signature_gate
run_test test_doctor_reports_source_update_signature_state
run_test test_release_contract_is_not_persisted_before_health
run_test test_failed_update_recovers_state_current
run_test test_normal_rollback_uses_state_previous
run_test test_rollback_blocks_migration_boundary_and_legacy_state
run_test test_pending_migration_blocks_failed_update_recovery
run_test test_pending_non_migration_allows_only_source_recovery
run_test test_state_persists_migration_rollback_requirement
run_test test_restored_rollback_blocks_unmigrated_reverse_path
run_test test_database_restore_authorizes_only_declared_release
run_test test_migration_transition_preserves_strongest_requirement
run_test test_migration_transition_never_replaces_another_contract
run_test test_verified_non_migration_retarget_requires_exact_forward_state
run_test test_migration_transition_retargets_verified_non_migration_descendant
run_test test_migration_transition_retargets_only_verified_gwg_034_recovery
run_test test_migration_transition_retargets_manually_recovered_legacy_target_before_new_migration
run_test test_migration_transition_captures_legacy_update_source_commit
run_test test_manual_gwg_034_resolution_requires_schema_invariants
run_test test_gwg_identity_invariant_contract_covers_schema_and_guards
run_test test_gwg_044_invariant_requires_immutable_evidence_versions
run_test test_manual_gwg_identity_resolution_requires_schema_invariants
run_test test_gwg_invariants_are_versioned_single_source
run_test test_gwg_invariant_sql_error_is_not_reported_as_violation
run_test test_gwg_invariants_keep_migration_presence_conditions
run_test test_gwg_034_retarget_requires_exact_forward_state
run_test test_compose_writer_passthrough_is_blocked_by_recovery_markers
run_test test_internal_writer_activation_is_bound_to_exact_contract
run_test test_full_backup_cannot_start_n8n_behind_restore_barrier
run_test test_restore_rollback_requires_explicit_matching_version
run_test test_inherited_internal_authorization_is_sanitized
run_test test_identical_redeploy_preserves_previous_state
run_test test_min_previous_without_state_fails_for_existing_installation
run_test test_secret_files_are_mode_0600
run_test test_ensure_secret_reports_known_dev_defaults

if (( TESTS_FAILED > 0 )); then
  printf '\n%s ops-lib tests failed, %s passed, %s skipped:\n' \
    "$TESTS_FAILED" "$TESTS_RUN" "$TESTS_SKIPPED" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
if (( TESTS_SKIPPED > 0 )); then
  printf '\n%s ops-lib tests passed, %s skipped (ssh-keygen/openssh-client fehlt; in CI Pflicht).\n' \
    "$TESTS_RUN" "$TESTS_SKIPPED"
else
  printf '\n%s ops-lib tests passed.\n' "$TESTS_RUN"
fi
