#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GITLEAKS="${1:-}"

[[ -n "$GITLEAKS" && -x "$GITLEAKS" ]] || {
  echo "Nutzung: $0 /pfad/zu/gitleaks" >&2
  exit 2
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "Gitleaks Config Test"

# Kalibrierter historischer False-Positive: ein leerer Secret-Platzhalter vor
# dem Bucket-Namen ist kein Secret und muss ohne Pfad-Komplettausnahme bestehen.
printf '%s\n' 'S3_SECRET_KEY=' 'S3_BUCKET_GOBD=gobd' > "$REPO/.env.example"
git -C "$REPO" add .env.example
git -C "$REPO" commit -qm "empty placeholder fixture"
"$GITLEAKS" git --config "$ROOT/.gitleaks.toml" --redact --no-banner "$REPO" \
  --report-format json --report-path "$TMP/empty.json" >/dev/null 2>&1
grep -qx '\[\]' "$TMP/empty.json"

# Gegenbeweis: derselbe Pfad mit einem nicht-leeren, rein synthetischen Wert
# muss weiterhin vom generic-api-key-Detektor blockiert werden.
printf '%s\n' \
  'S3_SECRET_KEY=Q7vN4mZ8pL2xR6cT9wK3dF5hJ1sB0yU4aE7qI6oP' \
  'S3_BUCKET_GOBD=gobd' > "$REPO/.env.example"
git -C "$REPO" add .env.example
git -C "$REPO" commit -qm "non-empty synthetic secret fixture"

set +e
"$GITLEAKS" git --config "$ROOT/.gitleaks.toml" --redact --no-banner "$REPO" \
  --report-format json --report-path "$TMP/non-empty.json" >/dev/null 2>&1
rc=$?
set -e
[[ $rc -eq 1 ]] || {
  echo "Nicht-leerer S3-Testwert wurde nicht mit dem erwarteten Leak-Exit 1 blockiert (Exit $rc)." >&2
  exit 1
}
grep -q '"RuleID": "generic-api-key"' "$TMP/non-empty.json"

# Die öffentliche Modellkennung sieht für die generische Entropie-Regel wie
# ein API-Key aus. Nur exakt dieser bekannte Wert in exakt der
# Provisionierungsdatei darf ausgenommen werden.
MODEL_REPO="$TMP/model-repo"
mkdir -p "$MODEL_REPO/scripts"
git -C "$MODEL_REPO" init -q
git -C "$MODEL_REPO" config user.email test@example.invalid
git -C "$MODEL_REPO" config user.name "Gitleaks Config Test"
printf '%s\n' 'MODEL_KEY = "granite-4.1-8b"' > \
  "$MODEL_REPO/scripts/provision-signal-llm.py"
git -C "$MODEL_REPO" add scripts/provision-signal-llm.py
git -C "$MODEL_REPO" commit -qm "public model identifier fixture"
"$GITLEAKS" git --config "$ROOT/.gitleaks.toml" --redact --no-banner "$MODEL_REPO" \
  --report-format json --report-path "$TMP/model-public.json" >/dev/null 2>&1
grep -qx '\[\]' "$TMP/model-public.json"

# Gegenbeweis: Die Ausnahme darf keinen anderen hochentropischen MODEL_KEY in
# derselben Datei maskieren.
printf '%s\n' 'MODEL_KEY = "Q7vN4mZ8pL2xR6cT9wK3dF5h"' > \
  "$MODEL_REPO/scripts/provision-signal-llm.py"
git -C "$MODEL_REPO" add scripts/provision-signal-llm.py
git -C "$MODEL_REPO" commit -qm "synthetic model key secret fixture"
set +e
"$GITLEAKS" git --config "$ROOT/.gitleaks.toml" --redact --no-banner "$MODEL_REPO" \
  --report-format json --report-path "$TMP/model-secret.json" >/dev/null 2>&1
model_rc=$?
set -e
[[ $model_rc -eq 1 ]] || {
  echo "Abweichender MODEL_KEY wurde nicht mit Leak-Exit 1 blockiert (Exit $model_rc)." >&2
  exit 1
}
grep -q '"RuleID": "generic-api-key"' "$TMP/model-secret.json"
grep -q '"File": "scripts/provision-signal-llm.py"' "$TMP/model-secret.json"

echo "4 gitleaks allowlist regression tests passed."
