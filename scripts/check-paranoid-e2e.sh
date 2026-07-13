#!/usr/bin/env sh
# =============================================================================
# Guard: Paranoid-E2E must stay complete and non-skippable.
#
# Compliance E2E tests are test evidence, not optional smoke coverage. This
# guard fails CI if a required paranoid spec disappears, is not wired into the
# Forgejo workflow, or if Playwright skip/only/fixme markers are introduced in
# the E2E suite.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".forgejo/workflows/ci.yml"
REQUIRED_SPECS="$(find apps/e2e/tests -maxdepth 1 -name '*.spec.ts' | sort)"

FAIL=0

for spec in $REQUIRED_SPECS; do
  if [ ! -f "$spec" ]; then
    echo "FEHLER: Pflicht-Paranoid-E2E-Spec fehlt: $spec" >&2
    FAIL=1
    continue
  fi

  workflow_ref="${spec#apps/e2e/}"
  if ! grep -Fq "$workflow_ref" "$WORKFLOW"; then
    echo "FEHLER: E2E-Spec ist nicht im CI-Workflow verdrahtet: $workflow_ref" >&2
    FAIL=1
  fi
done

# Die E2E-Infrastruktur muss dieselben Lock-Modi prüfen, die init-storage und
# Deploy-Readiness erzwingen. Insbesondere darf GwG nicht wieder auf COMPLIANCE
# driften: Dann wäre die bestätigte Vernichtung nach Fristablauf blockiert.
require_lock_policy() {
  bucket="$1"
  expected_mode="$2"
  expected_years="$3"
  any_count="$(grep -Ec "^[[:space:]]*assert_lock[[:space:]]+${bucket}[[:space:]]+" "$WORKFLOW" || true)"
  expected_count="$(grep -Ec "^[[:space:]]*assert_lock[[:space:]]+${bucket}[[:space:]]+${expected_mode}[[:space:]]+${expected_years}[[:space:]]*$" "$WORKFLOW" || true)"

  if [ "$any_count" -ne 1 ] || [ "$expected_count" -ne 1 ]; then
    echo "FEHLER: Object-Lock-Prüfung für ${bucket} muss exakt ${expected_mode}/${expected_years} Jahre erwarten." >&2
    FAIL=1
  fi
}

require_lock_policy gobd COMPLIANCE 10
require_lock_policy gwg GOVERNANCE 5

LOCK_QUERY='--query "ObjectLockConfiguration.Rule.DefaultRetention.[Mode,Years]"'
if ! grep -Fq -- "$LOCK_QUERY" "$WORKFLOW"; then
  echo "FEHLER: Object-Lock-Query muss bei ObjectLockConfiguration.Rule beginnen." >&2
  FAIL=1
fi

FORBIDDEN_PATTERN='(^|[^A-Za-z0-9_])(test|it|describe)\.(only|skip|fixme)([^A-Za-z0-9_]|$)'
HITS="$(grep -RInE "$FORBIDDEN_PATTERN" apps/e2e/tests --include='*.ts' 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  echo "FEHLER: Paranoid/E2E darf keine .only/.skip/.fixme Marker enthalten:" >&2
  echo "$HITS" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "Fix: Test entfernen/sauber machen oder bewusst ausserhalb der E2E-Suite dokumentieren." >&2
  exit 1
fi

echo "OK: Paranoid-E2E und Object-Lock-Pruefung sind vollstaendig und konsistent verdrahtet."
