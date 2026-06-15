#!/usr/bin/env sh
# =============================================================================
# Guard: no focused or disabled tests anywhere in app/package test code.
#
# A single `.only`, `.skip` or `.fixme` can silently invalidate compliance test
# evidence. The E2E suite has a dedicated wiring guard; this broader guard
# covers unit/integration tests across apps/ and packages/.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

FORBIDDEN_PATTERN='(^|[^A-Za-z0-9_])(test|it|describe)(\.[A-Za-z_][A-Za-z0-9_]*)?\.(only|skip|fixme)[[:space:]]*\('
FILES="$(find apps packages \
  \( -path '*/node_modules/*' -o -path '*/.next/*' -o -path '*/dist/*' -o -path '*/build/*' -o -path '*/coverage/*' -o -path '*/playwright-report/*' -o -path '*/test-results/*' \) -prune \
  -o \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print)"

HITS=""
if [ -n "$FILES" ]; then
  HITS="$(printf '%s\n' "$FILES" | xargs grep -nE "$FORBIDDEN_PATTERN" 2>/dev/null || true)"
fi

if [ -n "$HITS" ]; then
  echo "FEHLER: Tests duerfen keine .only/.skip/.fixme Marker enthalten:" >&2
  echo "$HITS" >&2
  echo "" >&2
  echo "Fix: Marker entfernen oder den Grund als echten Test/Guard abbilden." >&2
  exit 1
fi

echo "OK: keine fokussierten oder deaktivierten Tests gefunden."
