#!/usr/bin/env sh
# Compatibility entry point; the guard also runs directly on Windows via Node.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$ROOT/scripts/check-paranoid-e2e.mjs" "$@"
