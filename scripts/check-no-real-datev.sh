#!/usr/bin/env sh
# =============================================================================
# Guard: keine echten DATEV-Berater/Mandantennummern im Quellcode/Doku.
#
# Dieser Check blockt das DATEV-Dateinamen-Muster
#   <4-7 Ziffern>_<4-6 Ziffern>_<Jahr 19xx/20xx>
# in Quell-/Doku-Dateien. Echte Werte UND fake-aussehende reine
# Ziffern-Tripel werden geflaggt — als Beispiel IMMER nicht-numerische
# Platzhalter nutzen: <Beraternr>_<Mandantennr>_<Jahr>.
#
# Ausgabe maskiert Ziffern (#), damit der CI-Log selbst nichts leakt;
# Pfad/Zeile reichen zum Finden. Exit 1 bei Fund.
# =============================================================================
set -eu

# Regex bewusst nur über Zeichenklassen (enthält selbst KEIN Ziffern-Tripel,
# triggert sich also nicht).
PATTERN='[0-9]{4,7}_[0-9]{4,6}_(19|20)[0-9]{2}'

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# Nur relevante Text-/Quellpfade; Build-Output & Deps raus. Der Guard selbst
# (enthält Beispiel-Strings in Kommentaren) ist ausgenommen.
MATCHES="$(grep -rEn "$PATTERN" \
  --exclude-dir='node_modules' --exclude-dir='.next' --exclude-dir='dist' \
  --exclude-dir='.turbo' --exclude-dir='coverage' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --include='*.cjs' --include='*.json' --include='*.md' --include='*.sql' \
  --include='*.txt' --include='*.yml' --include='*.yaml' --include='*.prisma' \
  --include='*.css' --include='*.html' \
  apps packages docs infra scripts README.md FEATURES.md 2>/dev/null \
  | grep -v 'scripts/check-no-real-datev.sh' \
  || true)"

if [ -n "$MATCHES" ]; then
  echo "FEHLER: Mögliche echte DATEV-Berater/Mandantennummer gefunden" >&2
  echo "(Ziffern maskiert — Pfad:Zeile zeigt die Stelle):" >&2
  echo "$MATCHES" | sed -E 's/[0-9]/#/g' >&2
  echo "" >&2
  echo "Fix: keine echten Mandantendaten als Beispiel. Nicht-numerischer" >&2
  echo "Platzhalter, z. B. <Beraternr>_<Mandantennr>_<Jahr>." >&2
  exit 1
fi

echo "OK: kein DATEV-Nummern-Muster in Quellcode/Doku."
