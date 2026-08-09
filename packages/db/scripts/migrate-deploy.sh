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
EOL_CHECK="$SCRIPT_DIR/check-migration-line-endings.mjs"
RECOVERY_CHECK="$SCRIPT_DIR/inspect-migration-recovery.mjs"

if [ -z "$PRISMA_CLI" ] && ! command -v prisma >/dev/null 2>&1; then
  echo "FATAL: Prisma-CLI fehlt im PATH." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL fehlt." >&2
  exit 1
fi
if [ ! -r "$LEDGER_CHECK" ]; then
  echo "FATAL: Migration-Ledger-Check fehlt oder ist nicht lesbar: $LEDGER_CHECK" >&2
  exit 1
fi
if [ ! -r "$EOL_CHECK" ]; then
  echo "FATAL: Migration-Zeilenenden-Check fehlt oder ist nicht lesbar: $EOL_CHECK" >&2
  exit 1
fi
if [ ! -r "$RECOVERY_CHECK" ]; then
  echo "FATAL: Migration-Recovery-Check fehlt oder ist nicht lesbar: $RECOVERY_CHECK" >&2
  exit 1
fi

run_prisma() {
  if [ -n "$PRISMA_CLI" ]; then
    "$NODE_BIN" "$PRISMA_CLI" "$@"
  else
    prisma "$@"
  fi
}

"$NODE_BIN" "$EOL_CHECK"

recovery_state="$("$NODE_BIN" "$RECOVERY_CHECK")"
case "$recovery_state" in
  no-journal|not-recoverable) ;;
  recoverable)
    echo "INFO: Vollstaendig zurueckgerollten GwG-Migrationsfehler 03400 erkannt; Prisma-Journal wird sicher freigegeben."
    run_prisma migrate resolve --rolled-back "$MIGRATION"
    ;;
  *)
    echo "FATAL: Unbekanntes Ergebnis der Migration-Recovery-Pruefung: $recovery_state" >&2
    exit 1
    ;;
esac

# Vor dem Deploy sind nur exakt attestierte Pre-Release-Hashes erlaubt. Nach
# dem Deploy muss jede Repository-Migration exakt und vollstaendig im Ledger
# stehen. Damit kann `migrate deploy` geaenderte Altdateien nicht mehr still
# als bereits angewandt akzeptieren.
"$NODE_BIN" "$LEDGER_CHECK" --before-deploy
run_prisma migrate deploy
"$NODE_BIN" "$LEDGER_CHECK" --after-deploy
