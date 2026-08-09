#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/packages/db/scripts/migrate-deploy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat >"$TMP/bin/node" <<'MOCK'
#!/bin/sh
printf 'node %s\n' "$*" >>"$CALLS"
case "$*" in
  *inspect-migration-recovery.mjs*)
    case "$SCENARIO" in
      no-journal) echo no-journal ;;
      recoverable) echo recoverable ;;
      *) echo not-recoverable ;;
    esac
    ;;
esac
MOCK
chmod +x "$TMP/bin/node"

cat >"$TMP/bin/prisma" <<'MOCK'
#!/bin/sh
printf 'prisma %s\n' "$*" >>"$CALLS"
MOCK
chmod +x "$TMP/bin/prisma"

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
[[ "$(grep -c 'inspect-migration-recovery.mjs' "$calls")" -eq 1 ]]

calls="$(run_case recoverable)"
grep -q '^node /fake/prisma migrate resolve --rolled-back 20260801003400_gwg_fail_closed_and_destruction$' "$calls"
grep -q '^node /fake/prisma migrate deploy$' "$calls"
[[ "$(grep -c 'inspect-migration-recovery.mjs' "$calls")" -eq 1 ]]

calls="$(run_case other-failure)"
grep -q '^node /fake/prisma migrate deploy$' "$calls"
! grep -q 'migrate resolve' "$calls"
[[ "$(grep -c 'inspect-migration-recovery.mjs' "$calls")" -eq 1 ]]

public_calls="$TMP/public.calls"
: >"$public_calls"
PATH="$TMP/bin:$PATH" \
  CALLS="$public_calls" \
  SCENARIO=no-journal \
  NODE_BIN="$TMP/bin/node" \
  DATABASE_URL='postgresql://owner:secret@postgres:5432/taxtronik?schema=public' \
  sh "$SCRIPT" >/dev/null
grep -q '^prisma migrate deploy$' "$public_calls"

echo "4 migrate-deploy recovery tests passed."
