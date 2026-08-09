#!/bin/sh
set -eu

# Kompatibilitaets-Wrapper fuer den Linux-Migrate-Container und bestehende
# Operator-Aufrufe. Der eigentliche, plattformneutrale Ablauf lebt in Node.

PRISMA_CLI="${1:-}"
NODE_BIN="${NODE_BIN:-node}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/migrate-deploy.mjs"

[ -r "$LAUNCHER" ] || {
  echo "FATAL: Plattformneutraler Migration-Launcher fehlt: $LAUNCHER" >&2
  exit 1
}

if [ -n "$PRISMA_CLI" ]; then
  exec "$NODE_BIN" "$LAUNCHER" --prisma-cli "$PRISMA_CLI"
fi
exec "$NODE_BIN" "$LAUNCHER"
