#!/usr/bin/env sh
# =============================================================================
# Guard: CI service images must be pinned by digest.
#
# Floating tags in compliance CI make test evidence non-reproducible: the same
# commit can run against different database/cache images on different days.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

WORKFLOWS="$(find .forgejo/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)"
HITS="$(grep -nE '^[[:space:]]+image:[[:space:]]+[^[:space:]]+$' $WORKFLOWS \
  | grep -v '@sha256:' \
  || true)"

if [ -n "$HITS" ]; then
  echo "FEHLER: CI-Service-Images muessen per @sha256 gepinnt sein:" >&2
  echo "$HITS" >&2
  echo "" >&2
  echo "Fix: image: name:tag@sha256:<digest> verwenden." >&2
  exit 1
fi

echo "OK: alle CI-Service-Images sind per Digest gepinnt."
