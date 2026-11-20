#!/usr/bin/env bash
# BACKUP-DRILL-INTEGRITY-001 / AUDIT-HASH-CHAIN-001
set -euo pipefail
[[ ${CI:-} == true && ${PGPORT:-} == 15434 && ${PGDATABASE:-} == taxtronik ]] || {
  echo "Restore-Fixture nur im isolierten CI-PostgreSQL auf Port 15434." >&2; exit 1
}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
fixture="taxtronik_restore_fixture_$(node -p 'require("node:crypto").randomBytes(12).toString("hex")')"
suffix="$(node -p 'require("node:crypto").randomBytes(12).toString("hex")')"
sentinel="taxtronik_restore_$suffix"
fixture_created=0
sentinel_created=0
cleanup() {
  local rc=$?
  wait || true
  if (( fixture_created )); then dropdb "$fixture" || rc=1; fi
  if (( sentinel_created )); then dropdb "$sentinel" || rc=1; fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT

createdb "$sentinel"
sentinel_created=1
sentinel_oid() { psql -X -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT oid FROM pg_database WHERE datname='$sentinel'"; }
original_oid="$(sentinel_oid)"
[[ -n "$original_oid" ]]

# Erzwinge beim echten CREATE eine Kollision mit der bestehenden Kontroll-DB.
# Nur dieser Fehlerlauf bekommt die vorgegebene Zufallsfolge über seinen PATH.
mkdir "$work/bin"
cat > "$work/bin/node" <<'STUB'
#!/usr/bin/env bash
if [[ ${1:-} == -p && ${2:-} == *'randomBytes(12)'* ]]; then
  printf '%s\n' "$RESTORE_COLLISION_SUFFIX"
else
  exec "$RESTORE_REAL_NODE" "$@"
fi
STUB
chmod 700 "$work/bin/node"
real_node="$(command -v node)"
if RESTORE_COLLISION_SUFFIX="$suffix" RESTORE_REAL_NODE="$real_node" PATH="$work/bin:$PATH" \
    bash "$root/scripts/restore-selftest.sh" > "$work/collision" 2>&1; then
  echo "Ein Restore mit bereits belegter Zieldatenbank wurde angenommen." >&2; exit 1
fi
grep -Fq "$sentinel" "$work/collision"
grep -Fq '42P04' "$work/collision" # duplicate_database
[[ "$(sentinel_oid)" == "$original_oid" ]]
echo "Namenskollision beim CREATE abgewiesen. Die vorhandene Datenbank behält ihre OID."
createdb --template="$PGDATABASE" "$fixture"
fixture_created=1
export PGDATABASE="$fixture"
fixture_url() {
  node -e 'const u = new URL(process.env[process.argv[1]]); u.pathname = process.env.PGDATABASE; process.stdout.write(u.href)' "$1"
}
DATABASE_URL="$(fixture_url DATABASE_URL)"
DATABASE_APP_URL="$(fixture_url DATABASE_APP_URL)"
export DATABASE_URL DATABASE_APP_URL
( cd "$root/apps/web" && pnpm exec tsx scripts/ci-restore-audit.ts "$work/head" )
head="$(cat "$work/head")"
# Variiere genau ein Zeichen des außerhalb des Dumps festgehaltenen Quellhashs.
if [[ ${head: -1} == 0 ]]; then wrong_head="${head%?}1"; else wrong_head="${head%?}0"; fi
bash "$root/scripts/restore-selftest.sh" --expect-audit-head "$head" > "$work/ok" 2>&1 &
positive=$!
bash "$root/scripts/restore-selftest.sh" --expect-audit-head "$wrong_head" > "$work/mismatch" 2>&1 &
negative=$!
ok=0; mismatch=0
wait "$positive" || ok=$?
wait "$negative" || mismatch=$?
cat "$work/ok" "$work/mismatch"
[[ $ok == 0 && $mismatch != 0 ]]
grep -Fq 'Die erwartete zweigliedrige Auditkette oder ihre Quellspitze fehlt im Restore.' "$work/mismatch"
[[ "$(sentinel_oid)" == "$original_oid" ]]
echo "Zwei parallele Restore-Ziele: korrekte Quellspitze bestätigt, abweichende abgewiesen. Bestehende Datenbank beibehalten."
