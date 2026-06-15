#!/usr/bin/env sh
# =============================================================================
# Guard: CI actions must be pinned by immutable commit SHA.
#
# Action tags (v3/v4/main) can move. For compliance test evidence, every
# external `uses:` reference in the workflow must point at a 40-hex commit.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".forgejo/workflows/ci.yml"
HITS="$(grep -nE '^[[:space:]]+uses:[[:space:]]+[^[:space:]]+@[^[:space:]]+$' "$WORKFLOW" \
  | grep -vE '@[0-9a-f]{40}$' \
  || true)"

if [ -n "$HITS" ]; then
  echo "FEHLER: CI-Actions muessen per 40-stelligem Commit-SHA gepinnt sein:" >&2
  echo "$HITS" >&2
  echo "" >&2
  echo "Fix: uses: owner/action@<commit-sha> verwenden." >&2
  exit 1
fi

echo "OK: alle CI-Actions sind per Commit-SHA gepinnt."
