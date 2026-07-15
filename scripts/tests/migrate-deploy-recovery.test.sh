#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/packages/db/scripts/migrate-deploy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat >"$TMP/bin/psql" <<'MOCK'
#!/bin/sh
printf 'psql %s\n' "$*" >>"$CALLS"
case "$*" in
  *to_regclass*)
    case "$SCENARIO" in no-journal) echo f ;; *) echo t ;; esac
    ;;
  *)
    case "$SCENARIO" in recoverable) echo yes ;; *) echo no ;; esac
    ;;
esac
MOCK
chmod +x "$TMP/bin/psql"

cat >"$TMP/bin/node" <<'MOCK'
#!/bin/sh
printf 'node %s\n' "$*" >>"$CALLS"
MOCK
chmod +x "$TMP/bin/node"

run_case() {
  local scenario="$1" calls="$TMP/$1.calls"
  : >"$calls"
  PATH="$TMP/bin:$PATH" \
    CALLS="$calls" \
    SCENARIO="$scenario" \
    NODE_BIN="$TMP/bin/node" \
    DATABASE_URL='postgresql://owner:secret@postgres:5432/taxtronik?schema=public' \
    sh "$SCRIPT" /fake/prisma >/dev/null
  printf '%s' "$calls"
}

calls="$(run_case no-journal)"
grep -q '^node /fake/prisma migrate deploy$' "$calls"
! grep -q 'migrate resolve' "$calls"
[[ "$(grep -c '^psql ' "$calls")" -eq 1 ]]

calls="$(run_case recoverable)"
grep -q '^node /fake/prisma migrate resolve --rolled-back 20260801003400_gwg_fail_closed_and_destruction$' "$calls"
grep -q '^node /fake/prisma migrate deploy$' "$calls"
[[ "$(grep -c '^psql ' "$calls")" -eq 2 ]]

calls="$(run_case other-failure)"
grep -q '^node /fake/prisma migrate deploy$' "$calls"
! grep -q 'migrate resolve' "$calls"
[[ "$(grep -c '^psql ' "$calls")" -eq 2 ]]

echo "3 migrate-deploy recovery tests passed."
