#!/usr/bin/env sh
# =============================================================================
# Guard: keine ERiC-/ELSTER-Spezifikationsartefakte im Repository.
#
# Die ERiC-Unterlagen (Bibliotheken, Schnittstellenbeschreibungen/XSDs,
# Schemadokumentation, Entwicklerdoku) unterliegen der Vertraulichkeit aus
# der ELSTER-Lizenzvereinbarung (§ 14) — Repo-Inhalte landen in Releases,
# CI-Artefakten, Backups und Kunden-Checkouts und wären damit offengelegt.
# Ein Verstoß riskiert die Sperrung der Hersteller-ID (§ 9).
#
# Geprüft werden (1) getrackte Dateinamen und (2) Datei-Inhalte auf Marker,
# die nur in den Spezifikationsartefakten selbst vorkommen (API-Symbole,
# Schema-Namespace). Die Marker-Strings sind öffentlich bekannte Bezeichner
# — der Guard offenbart selbst nichts. Exit 1 bei Fund.
#
# Erlaubt bleiben die Wörter „ERiC"/„ELSTER" in Doku/Kommentaren (z. B.
# Architektur- und Pflichtenbeschreibung in docs/development/).
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

SELF='scripts/check-no-eric-spec.sh'
FAIL=0

# --- 1) Dateinamen: Bibliotheken, Schemata, Distributionspakete -------------
NAME_PATTERN='(\.xsd$|ericapi|ericmtapi|ericdemo|ottodemo|eSigner|ERiC-[0-9]|Schemadokumentation|Datenartversionmatrix|libcheck[A-Za-z]+[0-9]{4})'
NAME_HITS="$(git ls-files | grep -Ei "$NAME_PATTERN" | grep -v "$SELF" || true)"
if [ -n "$NAME_HITS" ]; then
  echo "FEHLER: Dateiname deutet auf ERiC-/ELSTER-Spezifikationsartefakt hin:" >&2
  echo "$NAME_HITS" >&2
  FAIL=1
fi

# --- 2) Inhalte: API-Symbole und Schema-Namespace ----------------------------
CONTENT_PATTERN='(Eric(Mt)?(Initialisiere|InstanzErzeugen|BearbeiteVorgang|Beende)|elster\.de/elsterxml|ElsterBasisSchema|EricGetHandleToCertificate)'
CONTENT_HITS="$(grep -rEn "$CONTENT_PATTERN" \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.turbo \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --include='*.cjs' --include='*.json' --include='*.md' --include='*.sql' \
  --include='*.txt' --include='*.yml' --include='*.yaml' --include='*.prisma' \
  --include='*.xml' --include='*.sh' --include='*.h' --include='*.c' \
  apps packages docs infra scripts README.md FEATURES.md CHANGELOG.md 2>/dev/null \
  | grep -v 'node_modules/' \
  | grep -v '/.next/' \
  | grep -v '/dist/' \
  | grep -v '/.turbo/' \
  | grep -v "$SELF" \
  || true)"
if [ -n "$CONTENT_HITS" ]; then
  echo "FEHLER: ERiC-/ELSTER-Spezifikationsmarker im Datei-Inhalt gefunden:" >&2
  echo "$CONTENT_HITS" | cut -c1-160 >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "Fix: ERiC-Artefakte gehoeren NICHT ins Repo (Vertraulichkeit der" >&2
  echo "Lizenzvereinbarung). Ablageort + Architektur: docs/development/" >&2
  echo "eric-integration.md — die Bridge lebt in einem separaten, privaten" >&2
  echo "Paket; das Repo enthaelt nur die neutrale Schnittstelle." >&2
  exit 1
fi

echo "OK: keine ERiC-/ELSTER-Spezifikationsartefakte im Repo."
