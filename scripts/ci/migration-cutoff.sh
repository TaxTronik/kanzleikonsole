#!/usr/bin/env bash
# =============================================================================
# Altbestands-Migrationstest mit Cutoff.
#
#   bash scripts/ci/migration-cutoff.sh <cutoff> <fixtures.sql> <asserts.sql>
#
# Baut eine frische Datenbank mit allen Migrationen bis einschliesslich
# <cutoff> (Verzeichnisname unter packages/db/prisma/migrations) auf, spielt
# <fixtures.sql> als historischen Datenbestand ein, wendet danach die
# restlichen Migrationen an und fuehrt <asserts.sql> aus. Ein Assert meldet
# einen Fehler per RAISE EXCEPTION. Zum Schluss prueft verify-migration-
# ledger.mjs, dass das Prisma-Ledger exakt dem Repository entspricht.
#
# Migrationen laufen per psql in Namensreihenfolge und werden wie von Prisma
# in _prisma_migrations journalisiert (SHA-256 der Datei). Ohne Prisma-Engines
# laeuft derselbe Test damit unveraendert in CI und lokal.
#
# Verbindung ueber libpq: PGHOST, PGPORT, PGUSER (Rolle mit CREATEDB, z. B.
# der Owner `taxtronik`), optional PGPASSWORD. Die Testdatenbank heisst
# taxtronik_cutoff_<Zeitstempel des Cutoffs> (MIGRATION_CUTOFF_DB setzt einen
# anderen Namen). Eine bereits vorhandene Datenbank fuehrt zum Abbruch und wird
# nie geloescht; entfernt wird am Ende nur die selbst angelegte Testdatenbank,
# ausser MIGRATION_CUTOFF_KEEP_DB=1.
#
# Exit: 0 bestanden, 1 Migration/Fixture/Assert/Ledger fehlgeschlagen,
#       2 Aufruf- oder Umgebungsfehler.
# =============================================================================
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT/packages/db/prisma/migrations"
BOOTSTRAP="$ROOT/packages/db/prisma/init/01_bootstrap.sql"
LEDGER_CHECK="$ROOT/packages/db/scripts/verify-migration-ledger.mjs"

usage() {
  echo "Aufruf: $0 <cutoff-migration> <fixtures.sql> <asserts.sql>" >&2
  exit 2
}
fail() {
  echo "FEHLER: $*" >&2
  exit 1
}
env_fail() {
  echo "FEHLER: $*" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage
CUTOFF="$1"
FIXTURES="$2"
ASSERTS="$3"

[[ "$CUTOFF" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || env_fail "Ungueltiger Cutoff: $CUTOFF"
[[ -f "$MIGRATIONS/$CUTOFF/migration.sql" ]] || env_fail "Cutoff-Migration fehlt: $CUTOFF"
[[ -r "$FIXTURES" ]] || env_fail "Fixture-Datei nicht lesbar: $FIXTURES"
[[ -r "$ASSERTS" ]] || env_fail "Assert-Datei nicht lesbar: $ASSERTS"
for cmd in psql createdb dropdb node sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || env_fail "Kommando fehlt: $cmd"
done

export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-taxtronik}"
# NOTICEs der Migrationen (IF NOT EXISTS, gekuerzte Bezeichner) nicht ins Log.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c client_min_messages=warning"
DB="${MIGRATION_CUTOFF_DB:-taxtronik_cutoff_${CUTOFF%%_*}}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || env_fail "Ungueltiger Testdatenbankname: $DB"

existing="$(psql -X -At -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")" ||
  env_fail "PostgreSQL unter $PGHOST:$PGPORT nicht erreichbar"
[[ -z "$existing" ]] || env_fail "Testdatenbank existiert bereits, Abbruch ohne Loeschung: $DB"

CREATED=0
cleanup() {
  if [[ "$CREATED" == 1 && "${MIGRATION_CUTOFF_KEEP_DB:-0}" != 1 ]]; then
    dropdb --if-exists --force "$DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

sql() { psql -X -q -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

createdb "$DB"
CREATED=1
sql -f "$BOOTSTRAP" >/dev/null
# Dieselbe Tabelle, die `prisma migrate deploy` beim ersten Lauf anlegt.
sql <<'SQL'
CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
SQL

apply_migration() {
  local name="$1" checksum
  checksum="$(sha256sum "$MIGRATIONS/$name/migration.sql" | cut -d' ' -f1)"
  sql -c "INSERT INTO _prisma_migrations (id, checksum, migration_name)
          VALUES (gen_random_uuid()::text, '$checksum', '$name')"
  sql -f "$MIGRATIONS/$name/migration.sql" >/dev/null ||
    fail "Migration $name ist fehlgeschlagen"
  sql -c "UPDATE _prisma_migrations
             SET finished_at = now(), applied_steps_count = 1
           WHERE migration_name = '$name'"
}

# Glob-Reihenfolge unter LC_ALL=C = Bytereihenfolge der Namen, wie bei Prisma.
BEFORE=()
AFTER=()
for file in "$MIGRATIONS"/2*/migration.sql; do
  [[ -f "$file" ]] || continue
  name="${file%/migration.sql}"
  name="${name##*/}"
  if [[ "$name" > "$CUTOFF" ]]; then AFTER+=("$name"); else BEFORE+=("$name"); fi
done
[[ ${#AFTER[@]} -gt 0 ]] || env_fail "Nach $CUTOFF folgt keine Migration; der Test waere leer."

echo "[migration-cutoff] $DB: ${#BEFORE[@]} Migrationen bis einschliesslich $CUTOFF"
for name in "${BEFORE[@]}"; do apply_migration "$name"; done

echo "[migration-cutoff] Altbestand laden: ${FIXTURES#"$ROOT"/}"
sql -f "$FIXTURES" || fail "Fixtures konnten nicht geladen werden: $FIXTURES"

echo "[migration-cutoff] ${#AFTER[@]} weitere Migrationen ab ${AFTER[0]}"
for name in "${AFTER[@]}"; do apply_migration "$name"; done

echo "[migration-cutoff] Erwartungen pruefen: ${ASSERTS#"$ROOT"/}"
sql -f "$ASSERTS" || fail "Assert fehlgeschlagen: $ASSERTS"

ledger_url="$(node -e '
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD } = process.env;
  const auth = encodeURIComponent(PGUSER) +
    (PGPASSWORD ? ":" + encodeURIComponent(PGPASSWORD) : "");
  process.stdout.write(`postgresql://${auth}@${PGHOST}:${PGPORT}/${process.argv[1]}`);
' "$DB")"
DATABASE_URL="$ledger_url" node "$LEDGER_CHECK" --after-deploy ||
  fail "Migrations-Ledger stimmt nach dem Test nicht mit dem Repository ueberein"

echo "[migration-cutoff] OK: $(basename "$ASSERTS") nach Cutoff $CUTOFF bestanden"
