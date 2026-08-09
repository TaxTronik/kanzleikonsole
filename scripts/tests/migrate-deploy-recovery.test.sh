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
MOCK
chmod +x "$TMP/bin/node"

calls="$TMP/explicit.calls"
: >"$calls"
CALLS="$calls" NODE_BIN="$TMP/bin/node" sh "$SCRIPT" /fake/prisma
grep -q 'migrate-deploy.mjs --prisma-cli /fake/prisma$' "$calls"

calls="$TMP/default.calls"
: >"$calls"
CALLS="$calls" NODE_BIN="$TMP/bin/node" sh "$SCRIPT"
grep -q 'migrate-deploy.mjs$' "$calls"

echo "2 migrate-deploy compatibility wrapper tests passed."
