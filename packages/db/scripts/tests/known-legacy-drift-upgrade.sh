#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)"
DB_PACKAGE="$ROOT/packages/db"
REPAIR='20260809000000_repair_known_legacy_migration_drift'
FORWARD_REPAIR='20260809000100_reconcile_repair_migration_history'
EOL_REPAIR='20260809000200_reconcile_windows_migration_line_endings'
LEGACY_DB_NAME="${LEGACY_DB_NAME:-taxtronik_known_legacy_drift}"
OWNER_URL="${LEGACY_DATABASE_URL:?LEGACY_DATABASE_URL fehlt}"
APP_URL="${LEGACY_DATABASE_APP_URL:?LEGACY_DATABASE_APP_URL fehlt}"
PRE_REPAIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/taxtronik-pre-repair-migrations.XXXXXX")"
PRE_REPAIR_MIGRATIONS="$PRE_REPAIR_ROOT/migrations"
TEMP_CONFIG="$DB_PACKAGE/known-legacy-upgrade.config.ts"
PRISMA_CLI=""
DATABASE_CREATED=0

cleanup() {
  rm -f "$TEMP_CONFIG"
  rm -rf "$PRE_REPAIR_ROOT"
  if [ "$DATABASE_CREATED" = '1' ]; then
    PGPASSWORD=taxtronik dropdb -h localhost -U taxtronik --if-exists --force \
      "$LEGACY_DB_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

case "$LEGACY_DB_NAME" in
  taxtronik_known_legacy_drift*) ;;
  *)
    echo "Unsicherer Testdatenbankname: $LEGACY_DB_NAME" >&2
    exit 1
    ;;
esac

[ ! -e "$TEMP_CONFIG" ] || {
  echo "Temporaere Prisma-Config existiert bereits: $TEMP_CONFIG" >&2
  exit 1
}

if PGPASSWORD=taxtronik psql -h localhost -U taxtronik -d postgres -Atc \
  "SELECT 1 FROM pg_database WHERE datname = '$LEGACY_DB_NAME'" | grep -q 1; then
  echo "Testdatenbank existiert bereits; Abbruch ohne Loeschung: $LEGACY_DB_NAME" >&2
  exit 1
fi

mkdir -p "$PRE_REPAIR_MIGRATIONS"
cp "$DB_PACKAGE/prisma/migrations/migration_lock.toml" "$PRE_REPAIR_MIGRATIONS/"
for migration in "$DB_PACKAGE"/prisma/migrations/20*; do
  [ -d "$migration" ] || continue
  name="${migration##*/}"
  case "$name" in
    "$REPAIR"|"$FORWARD_REPAIR"|"$EOL_REPAIR") continue ;;
  esac
  cp -a "$migration" "$PRE_REPAIR_MIGRATIONS/"
done

PGPASSWORD=taxtronik createdb -h localhost -U taxtronik "$LEGACY_DB_NAME"
DATABASE_CREATED=1
PGPASSWORD=taxtronik psql -h localhost -U taxtronik -d "$LEGACY_DB_NAME" \
  -v ON_ERROR_STOP=1 -f "$DB_PACKAGE/prisma/init/01_bootstrap.sql"

cat >"$TEMP_CONFIG" <<EOF
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: '$PRE_REPAIR_MIGRATIONS' },
  datasource: { url: env('DATABASE_URL') },
});
EOF

DATABASE_URL="$OWNER_URL" pnpm --dir "$DB_PACKAGE" exec prisma migrate deploy \
  --config known-legacy-upgrade.config.ts
rm -f "$TEMP_CONFIG"

PGPASSWORD=taxtronik psql -h localhost -U taxtronik -d "$LEGACY_DB_NAME" \
  -v ON_ERROR_STOP=1 -f "$DB_PACKAGE/scripts/tests/known-legacy-drift.sql"

PRISMA_CLI="$(find "$ROOT/node_modules" -path '*/prisma/build/index.js' \
  -not -path '*/cache/*' | head -n1)"
[ -n "$PRISMA_CLI" ] || {
  echo 'Prisma CLI wurde fuer den Upgrade-Test nicht gefunden.' >&2
  exit 1
}

(
  cd "$DB_PACKAGE"
  DATABASE_URL="$OWNER_URL" sh scripts/migrate-deploy.sh "$PRISMA_CLI"
)

DATABASE_URL="$OWNER_URL" DATABASE_APP_URL="$APP_URL" \
  pnpm --dir "$DB_PACKAGE" test
