#!/usr/bin/env sh
# =============================================================================
# Guard: no focused or disabled tests anywhere in app/package test code.
#
# A single `.only`, `.skip` or `.fixme` can silently invalidate compliance test
# evidence. The E2E suite has a dedicated wiring guard; this broader guard
# covers unit/integration tests across apps/ and packages/.
#
# -----------------------------------------------------------------------------
# Semantik (M-9a) — bewusst gestaffelt nach Schaedlichkeit:
#
# 1) IMMER verboten, auch OHNE anhaengende Klammer (Fokus ist per se toxisch):
#      .only          — fokussiert, blendet alle anderen Tests still aus.
#      .todo          — Platzhalter ohne Assertion, zaehlt faelschlich als "gruen".
#      fdescribe/fit  — Jasmine/Jest-Fokus-Aliase.
#    Das no-Klammer-Verbot fuer .only faengt auch das ternaere Fokus-Muster
#      cond ? describe.only : describe     (Marker als Wert statt Aufruf).
#
# 2) Nur als direkter AUFRUF verboten (unbedingtes Deaktivieren eines Blocks):
#      .skip(   /  .fixme(
#    Ein `describe.skip('x', ...)` schaltet einen Block bedingungslos ab.
#
# 3) WEITERHIN ERLAUBT — bedingte Skips MIT CI-Zwang an der Quelle:
#      .skipIf(  /  .runIf(          (Vitest-Guards, werfen in CI hart)
#      cond ? describe : describe.skip   (.skip als ternaerer ELSE-Wert)
#    Diese schalten Tests je nach Ressource (DB, openssl) ab, werfen aber in
#    CI HART, wenn die Ressource fehlt (siehe rls-cross-tenant.test.ts und
#    rfc3161-differential.test.ts: `if (process.env.CI && !hasX) throw`).
#    Deshalb wird `.skip` NUR als Aufruf `.skip(` verboten, nicht als Wert —
#    sonst wuerden die legitimen, CI-erzwungenen Ternaere faelschlich brechen.
#    Der Wortgrenzen-Kontext sorgt zudem dafuer, dass `.skip(` NICHT auf
#    `.skipIf(` und `.only`/`.todo` nicht auf laengere Bezeichner matcht.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# Gruppe 1 — Fokus-Marker, auch ohne Klammer (naechstes Zeichen kein Wortzeichen,
# damit .only nicht auf .onlyFoo und .todo nicht auf .todoList matcht):
FOCUS_MARKERS='(^|[^A-Za-z0-9_])(test|it|describe)(\.[A-Za-z_][A-Za-z0-9_]*)*\.(only|todo)($|[^A-Za-z0-9_])'
# Gruppe 2 — unbedingtes Deaktivieren, nur als Aufruf (.skip(/.fixme():
DISABLE_CALLS='(^|[^A-Za-z0-9_])(test|it|describe)(\.[A-Za-z_][A-Za-z0-9_]*)*\.(skip|fixme)[[:space:]]*\('
# Gruppe 1b — Jasmine/Jest-Fokus-Aliase:
JASMINE_ALIASES='(^|[^A-Za-z0-9_])(fdescribe|fit)[[:space:]]*\('
FORBIDDEN_PATTERN="$FOCUS_MARKERS|$DISABLE_CALLS|$JASMINE_ALIASES"

FILES="$(find apps packages \
  \( -path '*/node_modules/*' -o -path '*/.next/*' -o -path '*/dist/*' -o -path '*/build/*' -o -path '*/coverage/*' -o -path '*/playwright-report/*' -o -path '*/test-results/*' \) -prune \
  -o \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print)"

HITS=""
if [ -n "$FILES" ]; then
  HITS="$(printf '%s\n' "$FILES" | xargs grep -nE "$FORBIDDEN_PATTERN" 2>/dev/null || true)"
fi

if [ -n "$HITS" ]; then
  echo "FEHLER: Tests duerfen keine .only/.skip/.fixme/.todo oder fdescribe/fit Marker enthalten:" >&2
  echo "$HITS" >&2
  echo "" >&2
  echo "Fix: Marker entfernen oder den Grund als echten Test/Guard abbilden." >&2
  echo "Bedingte Skips mit CI-Zwang (.skipIf/.runIf) sind erlaubt." >&2
  exit 1
fi

echo "OK: keine fokussierten oder deaktivierten Tests gefunden."
