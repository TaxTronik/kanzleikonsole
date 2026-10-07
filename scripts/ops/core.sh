#!/usr/bin/env bash
# =============================================================================
# Grundlagen — Teil der Operator-CLI (./taxtronik).
#
# Ausgabe (info/warn/die), require_cmd, Prod-Preflight (assert_production_env,
# preflight_common) und der interaktive prompt-Helper.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

# ---------------------------------------------------------------------------
# Ausgabe-Helper
# ---------------------------------------------------------------------------
info() { printf '\n[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] !! %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { echo "FEHLER: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."; }

assert_production_env() {
  [[ "${NODE_ENV:-production}" == "production" ]] || \
    die "NODE_ENV muss fuer Operator-Skripte 'production' sein (aktuell: ${NODE_ENV:-unset}). Server nutzt ./taxtronik deploy, nicht scripts/setup.sh."
  [[ "${DATABASE_URL:-}" != "${DATABASE_APP_URL:-}" ]] || \
    die "DATABASE_URL und DATABASE_APP_URL duerfen nicht identisch sein (RLS-Backstop)."
}

preflight_common() {
  require_cmd docker
  require_cmd node
  require_cmd curl
  # N8N_HMAC_SECRET ist nur bei Legacy-Callbacks oder N8N_WEBHOOK_BASE_URL
  # Pflicht (B4); das prueft das App-Schema vor Backup und Migration.
  require_env \
    POSTGRES_PASSWORD TAXTRONIK_APP_PASSWORD AUTH_SECRET \
    S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY N8N_ENCRYPTION_KEY N8N_DB_PASSWORD
}

# prompt LABEL VAR [DEFAULT]: interaktiv erfragen, falls VAR noch ungesetzt und
# stdin ein TTY ist. Nicht-interaktive Aufrufe (CI) uebernehmen Env-Variablen.
prompt() {
  local label="$1" var="$2" def="${3:-}" input
  [[ -n "${!var:-}" ]] && return 0
  [[ -t 0 ]] || return 0
  read -rp "$label [$def]: " input || true
  printf -v "$var" '%s' "${input:-$def}"
}
