#!/usr/bin/env bash
# =============================================================================
# Gemeinsames Job-Setup fuer die Forgejo-Workflows.
#
#   bash scripts/ci/setup.sh <phase>...
#
# Phasen laufen in der angegebenen Reihenfolge:
#   install       pnpm install --frozen-lockfile --prod=false. pnpm fuehrt nur
#                 die in allowBuilds (pnpm-workspace.yaml) freigegebenen
#                 Install-Skripte aus und bricht wegen strictDepBuilds bei
#                 jedem ungeprueften Hook ab.
#   prisma        Prisma-Client fuer @taxtronik/db generieren.
#   pg-client     psql, createdb, dropdb und pg_isready bereitstellen. Mit
#                 PG_CLIENT_MAJOR=<n> zusaetzlich pg_dump/pg_restore in
#                 mindestens dieser Major-Version aus dem PGDG-Repository.
#   pg-bootstrap  Auf den PostgreSQL-Service des Jobs warten und Rollen und
#                 Extensions aus packages/db/prisma/init/01_bootstrap.sql in
#                 PGDATABASE (Standard: taxtronik) anlegen.
#
# Verbindung ueber die libpq-Variablen PGHOST, PGPORT, PGUSER und PGPASSWORD
# aus dem Job-env. Jeder Job mit PostgreSQL-Service hat einen eigenen Port,
# damit parallele Jobs im Host-Netz des Runners nicht kollidieren.
# Actions (checkout, setup-node, pnpm/action-setup, Artefakt-Uploads) bleiben
# im Workflow; dieses Skript buendelt nur die wiederholten Shell-Schritte.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() { printf '[ci-setup] %s\n' "$*"; }
die() {
  printf 'FEHLER: %s\n' "$*" >&2
  exit 1
}

phase_install() {
  log 'pnpm install mit den geprueften Install-Skripten (allowBuilds, strictDepBuilds)'
  pnpm install --frozen-lockfile --prod=false
}

phase_prisma() {
  log 'Prisma-Client generieren'
  pnpm --filter @taxtronik/db exec prisma generate
}

pg_client_ready() {
  local cmd major
  for cmd in psql createdb dropdb pg_isready; do
    command -v "$cmd" >/dev/null 2>&1 || return 1
  done
  if [ -n "${PG_CLIENT_MAJOR:-}" ]; then
    # command -v-Guard: fehlt pg_dump, wuerde `pg_dump --version | ...` unter
    # pipefail sonst mit 127 abbrechen, bevor installiert wird.
    command -v pg_dump >/dev/null 2>&1 || return 1
    major="$(pg_dump --version | awk '{print $3}' | cut -d. -f1)"
    [ "${major:-0}" -ge "$PG_CLIENT_MAJOR" ] || return 1
  fi
}

phase_pg_client() {
  if [ -n "${PG_CLIENT_MAJOR:-}" ] && ! [[ "$PG_CLIENT_MAJOR" =~ ^[0-9]+$ ]]; then
    die "PG_CLIENT_MAJOR ist keine Major-Version: $PG_CLIENT_MAJOR"
  fi
  if pg_client_ready; then
    log "PostgreSQL-Client vorhanden: $(psql --version)"
    return
  fi
  local sudo=""
  if command -v sudo >/dev/null 2>&1; then sudo=sudo; fi
  $sudo apt-get update
  if [ -z "${PG_CLIENT_MAJOR:-}" ]; then
    $sudo apt-get install -y postgresql-client
  else
    # pg_dump bricht hart ab, wenn der Server neuer ist als der Client
    # ("aborting because of server version mismatch"); die Distro-Pakete sind
    # aelter als der PostgreSQL-18-Service. Daher der Client aus dem PGDG-Repo.
    $sudo apt-get install -y curl ca-certificates
    $sudo install -d /usr/share/postgresql-common/pgdg
    $sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" |
      $sudo tee /etc/apt/sources.list.d/pgdg.list
    $sudo apt-get update
    $sudo apt-get install -y "postgresql-client-$PG_CLIENT_MAJOR"
  fi
  pg_client_ready || die 'PostgreSQL-Client ist nach der Installation unvollstaendig.'
  log "PostgreSQL-Client: $(psql --version)"
}

phase_pg_bootstrap() {
  : "${PGHOST:?PGHOST fehlt im Job-env}" "${PGPORT:?PGPORT fehlt im Job-env}"
  : "${PGUSER:?PGUSER fehlt im Job-env}"
  local database="${PGDATABASE:-taxtronik}" attempt
  for attempt in $(seq 1 30); do
    if pg_isready -q -d "$database"; then break; fi
    [ "$attempt" -lt 30 ] || die "PostgreSQL unter $PGHOST:$PGPORT ist nach 60 s nicht bereit."
    sleep 2
  done
  log "Rollen und Extensions in $database anlegen ($PGHOST:$PGPORT)"
  psql -X -v ON_ERROR_STOP=1 -d "$database" -f packages/db/prisma/init/01_bootstrap.sql
}

[ $# -gt 0 ] || die "Aufruf: $0 <install|prisma|pg-client|pg-bootstrap>..."
for phase in "$@"; do
  case "$phase" in
    install) phase_install ;;
    prisma) phase_prisma ;;
    pg-client) phase_pg_client ;;
    pg-bootstrap) phase_pg_bootstrap ;;
    *) die "Unbekannte Setup-Phase: $phase" ;;
  esac
done
