#!/usr/bin/env bash
# =============================================================================
# Automatisierter Backup→Restore-Roundtrip-Selbsttest.
#
# Fährt den ECHTEN Code-Pfad: runner.ts (--out-file) erzeugt einen pg_dump,
# restore.ts (--file) spielt ihn via pg_restore in eine frische Ziel-DB ein.
# Anschließend drei Integritäts-Assertions:
#   A) Zeilenzahl-Vergleich Quelle↔Ziel für die wichtigsten Tabellen
#   B) App-Rolle + sicherheitskritische Grants/REVOKEs sind wiederhergestellt
#   C) verify:chain auf der wiederhergestellten DB (Audit-Hash-Chain intakt?)
#
# Läuft eigenständig — KEINE Prod-.env nötig. Quelle = $DATABASE_URL, das Ziel
# wird daraus abgeleitet (gleiche Verbindung, DB-Name `taxtronik_restore`).
#
# Lokal:   DATABASE_URL=postgresql://… DATABASE_APP_URL=postgresql://… \
#            bash scripts/restore-selftest.sh
# In CI:   eigener Job `restore` (siehe .forgejo/workflows/ci.yml).
# =============================================================================

# Das Skript nutzt bash-Features (pipefail, [[ … ]], BASH_SOURCE). Wird es per
# `sh …` aufgerufen (auf Debian/Ubuntu ist sh = dash), scheitert sonst schon
# `set -o pipefail`. Daher unter einer Nicht-bash-Shell sofort mit bash neu
# starten.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { printf '\n[selftest] %s\n' "$*"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."; }
require_cmd psql
require_cmd pnpm
require_cmd node

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL nicht gesetzt (Quelle des Selbsttests)."
[[ -n "${DATABASE_APP_URL:-}" ]] || die "DATABASE_APP_URL nicht gesetzt (App-Rollen-Pruefung des Selbsttests)."

SRC_URL="$DATABASE_URL"
APP_URL="$DATABASE_APP_URL"
TARGET_DB="taxtronik_restore"

# -----------------------------------------------------------------------------
# DATABASE_URL zerlegen. Prisma-URLs tragen Query-Parameter (?schema=…), die
# libpq NICHT kennt — psql bricht damit ab: `invalid URI query parameter:
# "schema"`. psql bekommt deshalb NIE die URI, sondern (symmetrisch zu
# buildPgConnArgs in runner.ts/restore.ts, P-2) die Einzelteile via
# -h/-p/-U/-d plus PGPASSWORD/PGSSLMODE — so landet das Passwort auch nicht
# in den Prozess-Args (/proc/<pid>/cmdline). Die VOLLE URL (inkl. ?schema=)
# behalten nur die Prisma-Aufrufe (restore.ts, verify:chain).
# -----------------------------------------------------------------------------
url_part() {
  node -e '
    const u = new URL(process.argv[1]);
    const part = {
      host: u.hostname,
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      dbname: u.pathname.slice(1),
      sslmode: u.searchParams.get("sslmode") || "",
    }[process.argv[2]];
    if (part === undefined) { console.error("url_part: unbekannter Teil"); process.exit(1); }
    process.stdout.write(part);
  ' "$1" "$2"
}

PG_HOST="$(url_part "$SRC_URL" host)"
PG_PORT="$(url_part "$SRC_URL" port)"
PG_USER="$(url_part "$SRC_URL" user)"
SRC_DBNAME="$(url_part "$SRC_URL" dbname)"
# Getrennt zuweisen + exportieren: `export VAR=$(cmd)` würde unter set -e einen
# Fehler von cmd verschlucken (Exit-Status des export zählt).
PG_PASSWORD="$(url_part "$SRC_URL" password)"
export PGPASSWORD="$PG_PASSWORD"
PG_SSLMODE="$(url_part "$SRC_URL" sslmode)"
if [[ -n "$PG_SSLMODE" ]]; then export PGSSLMODE="$PG_SSLMODE"; fi

APP_PG_HOST="$(url_part "$APP_URL" host)"
APP_PG_PORT="$(url_part "$APP_URL" port)"
APP_PG_USER="$(url_part "$APP_URL" user)"
APP_PG_PASSWORD="$(url_part "$APP_URL" password)"
APP_PG_SSLMODE="$(url_part "$APP_URL" sslmode)"
[[ "$APP_PG_USER" == "taxtronik_app" ]] || die "DATABASE_APP_URL muss fuer den Selftest die Rolle taxtronik_app verwenden."

[[ "$SRC_DBNAME" != "$TARGET_DB" ]] || die "Quelle ist bereits '$TARGET_DB' — Abbruch (würde Quelle zerstören)."

# Ziel-URL für die Prisma-Seite: gleiche Verbindung + Query, DB-Name TARGET_DB.
SRC_BASE="${SRC_URL%%\?*}"        # alles vor dem ersten '?'
SRC_QUERY=""
if [[ "$SRC_URL" == *\?* ]]; then SRC_QUERY="?${SRC_URL#*\?}"; fi
TARGET_URL="${SRC_BASE%/*}/${TARGET_DB}${SRC_QUERY}"

# psql gegen eine benannte DB derselben Verbindung (Teile s. o.).
psql_db() {
  local db="$1"; shift
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"
}

psql_app_db() {
  local db="$1"; shift
  if [[ -n "$APP_PG_SSLMODE" ]]; then
    PGPASSWORD="$APP_PG_PASSWORD" PGSSLMODE="$APP_PG_SSLMODE" \
      psql -h "$APP_PG_HOST" -p "$APP_PG_PORT" -U "$APP_PG_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"
  else
    PGPASSWORD="$APP_PG_PASSWORD" \
      psql -h "$APP_PG_HOST" -p "$APP_PG_PORT" -U "$APP_PG_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"
  fi
}

TMP="$(mktemp -d)"
DUMP_FILE="$TMP/selftest.dump"

# -----------------------------------------------------------------------------
# Aufräumen (auch bei Fehler): Temp-Verzeichnis + Ziel-DB droppen.
# -----------------------------------------------------------------------------
cleanup() {
  local rc=$?
  rm -rf "$TMP" 2>/dev/null || true
  # Ziel-DB best-effort droppen; Fehler hier dürfen den Exit-Code nicht ändern.
  psql_db postgres -q \
    -c "DROP DATABASE IF EXISTS $TARGET_DB WITH (FORCE)" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# Hilfsfunktion: count(*) einer Tabelle in einer benannten DB.
count_rows() {
  local db="$1" table="$2"
  psql_db "$db" -tA -c "SELECT count(*) FROM \"$table\""
}

# -----------------------------------------------------------------------------
# 1./2. Ziel-DB frisch anlegen. Rollen sind cluster-global → schon vorhanden.
# -----------------------------------------------------------------------------
info "Ziel-DB '$TARGET_DB' neu anlegen…"
psql_db postgres -q \
  -c "DROP DATABASE IF EXISTS $TARGET_DB WITH (FORCE)" \
  -c "CREATE DATABASE $TARGET_DB"

# -----------------------------------------------------------------------------
# 3. Dump der Quelle erzeugen (echter runner-Code, lokaler Datei-Sink).
# -----------------------------------------------------------------------------
info "Dump der Quelle erzeugen (runner.ts --out-file)…"
# --env-file-if-exists lädt lokal ../../.env (wie das backup:run-Script); in CI
# kommen die ENV-Werte aus dem Job — die Flag ist dort ein No-Op. DATABASE_URL
# überschreiben wir bewusst inline auf die jeweilige Quelle/Ziel-DB.
( cd "$ROOT/apps/web" && DATABASE_URL="$SRC_URL" \
    pnpm exec tsx --env-file-if-exists=../../.env \
      src/server/backup/runner.ts --out-file "$DUMP_FILE" )
[[ -s "$DUMP_FILE" ]] || die "Dump-Datei wurde nicht erzeugt oder ist leer."

# -----------------------------------------------------------------------------
# 4. Restore in die Ziel-DB (echter restore-Code, lokale Datei-Quelle).
#    --confirm-overwrite, weil die CREATE DATABASE eine frische, aber nicht
#    zwingend „leere" (im Sinne von _prisma_migrations) DB liefert.
#    Harmlose pg_restore-Notices (DROP … IF EXISTS auf nicht existente Objekte)
#    sind in eine frische DB NORMAL und kein Fehler — --single-transaction +
#    --exit-on-error behandeln nur echte Fehler.
# -----------------------------------------------------------------------------
info "Restore in '$TARGET_DB' (restore.ts --file)…"
( cd "$ROOT/apps/web" && DATABASE_URL="$TARGET_URL" \
    pnpm exec tsx --env-file-if-exists=../../.env \
      src/server/backup/restore.ts --file "$DUMP_FILE" \
        --target-url "$TARGET_URL" --confirm-overwrite )

# -----------------------------------------------------------------------------
# 5. Assertion A — Zeilenzahl-Vergleich für die wichtigsten Tabellen.
# -----------------------------------------------------------------------------
info "Assertion A: Zeilenzahlen Quelle ↔ Ziel vergleichen…"
TABLES=(tenant audit_log client document invoice)
ASSERT_OK=1
for t in "${TABLES[@]}"; do
  src_n="$(count_rows "$SRC_DBNAME" "$t")"
  dst_n="$(count_rows "$TARGET_DB" "$t")"
  if [[ "$src_n" != "$dst_n" ]]; then
    echo "  ✗ $t: Quelle=$src_n  Ziel=$dst_n  (ABWEICHUNG)"
    ASSERT_OK=0
  else
    echo "  ✓ $t: $src_n Zeilen (Quelle = Ziel)"
  fi
done
[[ "$ASSERT_OK" -eq 1 ]] || die "Zeilenzahl-Vergleich fehlgeschlagen — Restore unvollständig."

# -----------------------------------------------------------------------------
# 6. Assertion B — ACL-/RLS-Sicherheitszustand auf der Ziel-DB.
# Ein vollständiger fachlicher Restore muss nicht nur Daten/DDL, sondern auch
# die PostgreSQL-Privilegien erhalten. Insbesondere dürfen die REVOKEs auf
# Audit-Tabellen und SECURITY-DEFINER-Funktionen nicht verloren gehen.
# -----------------------------------------------------------------------------
info "Assertion B: App-Rolle und sicherheitskritische ACLs prüfen…"

ACL_STATE="$(psql_db "$TARGET_DB" -tA <<'SQL'
SELECT concat_ws('|',
  (EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'taxtronik_app'
       AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
       AND NOT rolreplication AND NOT rolbypassrls
  ))::text,
  has_schema_privilege('taxtronik_app', 'app', 'USAGE')::text,
  has_function_privilege('taxtronik_app', 'app.current_tenant_id()', 'EXECUTE')::text,
  has_function_privilege('taxtronik_app', 'app.destroy_gwg_check(uuid)', 'EXECUTE')::text,
  has_function_privilege('taxtronik_app', 'app.destroy_gwg_document_versions(uuid)', 'EXECUTE')::text,
  has_table_privilege('taxtronik_app', 'audit_log', 'SELECT')::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_log', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_log', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_log', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_seal', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_seal', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_seal', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_archive', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_archive', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'audit_archive', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'document_version', 'DELETE'))::text,
  (NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
     WHERE p.oid IN (
       'app.destroy_gwg_check(uuid)'::regprocedure,
       'app.assert_gwg_document_destruction_due(uuid)'::regprocedure,
       'app.destroy_gwg_document_versions(uuid)'::regprocedure
     )
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ))::text
);
SQL
)"
EXPECTED_ACL_STATE="true|true|true|true|true|true|true|true|true|true|true|true|true|true|true|true|true"
[[ "$ACL_STATE" == "$EXPECTED_ACL_STATE" ]] || \
  die "ACL-/REVOKE-Pruefung fehlgeschlagen: $ACL_STATE"

# Wirklich als eingeschränkte Rolle verbinden: Schema/Funktion müssen
# nutzbar sein, RLS muss ohne Tenant-Kontext gleichzeitig alle Tenant-Zeilen
# ausblenden.
APP_PROBE="$(psql_app_db "$TARGET_DB" -tA -c \
  "SELECT current_user || '|' || COALESCE(app.current_tenant_id()::text, 'NULL') || '|' || (SELECT count(*) FROM tenant)::text")"
[[ "$APP_PROBE" == "taxtronik_app|NULL|0" ]] || \
  die "App-Rollen-/RLS-Probe fehlgeschlagen: $APP_PROBE"
echo "  ✓ taxtronik_app funktionsfähig; kritische Grants/REVOKEs und RLS intakt"

# -----------------------------------------------------------------------------
# 7. Assertion C (compliance-kritisch) — Audit-Hash-Chain auf der Ziel-DB.
#    Bricht die Chain auf der wiederhergestellten DB, ist das Backup für GoBD
#    wertlos. Daher harter Fehler.
# -----------------------------------------------------------------------------
info "Assertion C: verify:chain auf '$TARGET_DB'…"
( cd "$ROOT" && DATABASE_URL="$TARGET_URL" pnpm verify:chain )

# -----------------------------------------------------------------------------
# Erfolg.
# -----------------------------------------------------------------------------
info "Restore-Selbsttest ERFOLGREICH."
echo "  Quelle: $SRC_DBNAME → Ziel: $TARGET_DB"
echo "  Verglichene Tabellen (Zeilen):"
for t in "${TABLES[@]}"; do
  echo "    $t = $(count_rows "$TARGET_DB" "$t")"
done
echo "  Audit-Hash-Chain auf der wiederhergestellten DB: intakt."
