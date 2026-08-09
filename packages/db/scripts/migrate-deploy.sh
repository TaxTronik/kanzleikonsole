#!/bin/sh
set -eu

# Produktions-Wrapper fuer Prisma Migrate. Migration 03400 konnte auf einem
# v0.1-Altbestand vor ihrer Korrektur mit SQLSTATE 42883 abbrechen. PostgreSQL
# und Prisma rollen dieses konkrete Skript vollstaendig zurueck; nur der
# fehlgeschlagene Journaleintrag blockiert danach den erneuten Deploy.
#
# Ausschliesslich dieser exakt erkannte, nachweislich unangewendete Fehler wird
# automatisch als rolled-back markiert. Jeder andere Fehler bleibt fail-closed.

PRISMA_CLI="${1:-}"
NODE_BIN="${NODE_BIN:-node}"
MIGRATION="20260801003400_gwg_fail_closed_and_destruction"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LEDGER_CHECK="$SCRIPT_DIR/verify-migration-ledger.mjs"

if [ -z "$PRISMA_CLI" ]; then
  echo "FATAL: Pfad zur Prisma-CLI fehlt." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL fehlt." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "FATAL: psql fehlt; sichere Migrations-Recovery ist nicht moeglich." >&2
  exit 1
fi
if [ ! -r "$LEDGER_CHECK" ]; then
  echo "FATAL: Migration-Ledger-Check fehlt oder ist nicht lesbar: $LEDGER_CHECK" >&2
  exit 1
fi

# Prisma versteht ?schema=public; libpq/psql nicht. URL-kodierte Fragezeichen
# im Passwort erscheinen als %3F und werden hiervon nicht beruehrt.
PSQL_URL=${DATABASE_URL%%\?*}

has_journal="$(
  psql "$PSQL_URL" -X -v ON_ERROR_STOP=1 -Atc \
    "SELECT pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL"
)"

if [ "$has_journal" = "t" ]; then
  recoverable="$(
    psql "$PSQL_URL" -X -v ON_ERROR_STOP=1 -Atc "
      SELECT CASE WHEN
        EXISTS (
          SELECT 1
            FROM public._prisma_migrations
           WHERE migration_name = '$MIGRATION'
             AND finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
             AND logs LIKE '%42883%'
             AND logs LIKE '%destroy_gwg_check(uuid)%'
        )
        AND pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE (table_schema, table_name, column_name) IN (
             ('public', 'gwg_check', 'legal_form'),
             ('public', 'gwg_check', 'register_number'),
             ('public', 'gwg_check', 'register_authority'),
             ('public', 'gwg_check', 'no_register_entry'),
             ('public', 'gwg_check', 'representative_names'),
             ('public', 'gwg_check', 'ownership_structure_notes'),
             ('public', 'document', 'gwg_onboarding_invite_id'),
             ('public', 'document', 'gwg_destruction_requested_at'),
             ('public', 'document', 'gwg_destruction_requested_by'),
             ('public', 'document', 'gwg_destruction_error'),
             ('public', 'document', 'gwg_destroyed_at')
           )
        )
        THEN 'yes' ELSE 'no'
      END"
  )"

  if [ "$recoverable" = "yes" ]; then
    echo "INFO: Vollstaendig zurueckgerollten GwG-Migrationsfehler 03400 erkannt; Prisma-Journal wird sicher freigegeben."
    "$NODE_BIN" "$PRISMA_CLI" migrate resolve --rolled-back "$MIGRATION"
  fi
fi

# Vor dem Deploy sind nur exakt attestierte Pre-Release-Hashes erlaubt. Nach
# dem Deploy muss jede Repository-Migration exakt und vollstaendig im Ledger
# stehen. Damit kann `migrate deploy` geaenderte Altdateien nicht mehr still
# als bereits angewandt akzeptieren.
"$NODE_BIN" "$LEDGER_CHECK" --before-deploy
"$NODE_BIN" "$PRISMA_CLI" migrate deploy
"$NODE_BIN" "$LEDGER_CHECK" --after-deploy
