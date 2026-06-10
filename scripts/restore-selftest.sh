#!/usr/bin/env bash
# =============================================================================
# Automatisierter Backup→Restore-Roundtrip-Selbsttest.
#
# Fährt den ECHTEN Code-Pfad: runner.ts (--out-file) erzeugt einen pg_dump,
# restore.ts (--file) spielt ihn via pg_restore in eine frische Ziel-DB ein.
# Anschließend zwei Integritäts-Assertions:
#   A) Zeilenzahl-Vergleich Quelle↔Ziel für die wichtigsten Tabellen
#   B) verify:chain auf der wiederhergestellten DB (Audit-Hash-Chain intakt?)
#
# Läuft eigenständig — KEINE Prod-.env nötig. Quelle = $DATABASE_URL, das Ziel
# wird daraus abgeleitet (gleiche Verbindung, DB-Name `taxtronik_restore`).
#
# Lokal:   DATABASE_URL=postgresql://… bash scripts/restore-selftest.sh
# In CI:   eigener Job `restore` (siehe .forgejo/workflows/ci.yml).
# =============================================================================

# Das Skript nutzt bash-Features (pipefail, [[ … ]], BASH_SOURCE). Wird es per
# `sh …` aufgerufen (auf Debian/Ubuntu ist sh = dash), scheitert sonst schon
# `set -o pipefail`. Daher unter einer Nicht-bash-Shell sofort mit bash neu
# starten.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { printf '\n[selftest] %s\n' "$*"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."; }
require_cmd psql
require_cmd pnpm

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL nicht gesetzt (Quelle des Selbsttests)."

SRC_URL="$DATABASE_URL"
TARGET_DB="taxtronik_restore"

# -----------------------------------------------------------------------------
# DATABASE_URL zerlegen. Wir bauen daraus:
#   - die Ziel-URL (gleiche Verbindung, DB-Name TARGET_DB) für restore/verify
#   - eine Admin-URL auf die `postgres`-DB für DROP/CREATE der Ziel-DB
# psql bekommt die Verbindungsdaten als URL übergeben; das Passwort steckt darin
# und wird so nicht über die Prozess-Args sichtbar (psql liest die URL selbst).
# -----------------------------------------------------------------------------
# Schema-Query (?schema=… / ?sslmode=…) am Ende abtrennen und für die Ziel-URL
# wiederverwenden, damit search_path/SSL-Verhalten gleich bleiben.
SRC_BASE="${SRC_URL%%\?*}"        # alles vor dem ersten '?'
SRC_QUERY=""
if [[ "$SRC_URL" == *\?* ]]; then SRC_QUERY="?${SRC_URL#*\?}"; fi

# Verbindungs-Präfix (postgresql://user:pw@host:port/) vom DB-Namen trennen.
PREFIX="${SRC_BASE%/*}/"          # bis inkl. letztem '/'
SRC_DBNAME="${SRC_BASE##*/}"      # DB-Name der Quelle

[[ "$SRC_DBNAME" != "$TARGET_DB" ]] || die "Quelle ist bereits '$TARGET_DB' — Abbruch (würde Quelle zerstören)."

TARGET_URL="${PREFIX}${TARGET_DB}${SRC_QUERY}"
ADMIN_URL="${PREFIX}postgres${SRC_QUERY}"

TMP="$(mktemp -d)"
DUMP_FILE="$TMP/selftest.dump"

# -----------------------------------------------------------------------------
# Aufräumen (auch bei Fehler): Temp-Verzeichnis + Ziel-DB droppen.
# -----------------------------------------------------------------------------
cleanup() {
  local rc=$?
  rm -rf "$TMP" 2>/dev/null || true
  # Ziel-DB best-effort droppen; Fehler hier dürfen den Exit-Code nicht ändern.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS $TARGET_DB WITH (FORCE)" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# Hilfsfunktion: count(*) einer Tabelle gegen eine gegebene URL.
count_rows() {
  local url="$1" table="$2"
  psql "$url" -v ON_ERROR_STOP=1 -tA -c "SELECT count(*) FROM \"$table\""
}

# -----------------------------------------------------------------------------
# 1./2. Ziel-DB frisch anlegen. Rollen sind cluster-global → schon vorhanden.
# -----------------------------------------------------------------------------
info "Ziel-DB '$TARGET_DB' neu anlegen…"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $TARGET_DB WITH (FORCE)" \
  -c "CREATE DATABASE $TARGET_DB"

# -----------------------------------------------------------------------------
# 3. Dump der Quelle erzeugen (echter runner-Code, lokaler Datei-Sink).
# -----------------------------------------------------------------------------
info "Dump der Quelle erzeugen (runner.ts --out-file)…"
# --env-file-if-exists lädt lokal ../../.env (wie das backup:run-Script); in CI
# kommen die ENV-Werte aus dem Job — die Flag ist dort ein No-Op. DATABASE_URL
# überschreiben wir bewusst inline auf die jeweilige Quelle/Ziel-DB.
( cd "$ROOT/apps/web" && DATABASE_URL="$SRC_URL" \
    pnpm exec tsx --env-file-if-exists=../../.env \
      src/server/backup/runner.ts --out-file "$DUMP_FILE" )
[[ -s "$DUMP_FILE" ]] || die "Dump-Datei wurde nicht erzeugt oder ist leer."

# -----------------------------------------------------------------------------
# 4. Restore in die Ziel-DB (echter restore-Code, lokale Datei-Quelle).
#    --confirm-overwrite, weil die CREATE DATABASE eine frische, aber nicht
#    zwingend „leere" (im Sinne von _prisma_migrations) DB liefert.
#    Harmlose pg_restore-Notices (DROP … IF EXISTS auf nicht existente Objekte)
#    sind in eine frische DB NORMAL und kein Fehler — --single-transaction +
#    --exit-on-error behandeln nur echte Fehler.
# -----------------------------------------------------------------------------
info "Restore in '$TARGET_DB' (restore.ts --file)…"
( cd "$ROOT/apps/web" && DATABASE_URL="$TARGET_URL" \
    pnpm exec tsx --env-file-if-exists=../../.env \
      src/server/backup/restore.ts --file "$DUMP_FILE" --confirm-overwrite )

# -----------------------------------------------------------------------------
# 5. Assertion A — Zeilenzahl-Vergleich für die wichtigsten Tabellen.
# -----------------------------------------------------------------------------
info "Assertion A: Zeilenzahlen Quelle ↔ Ziel vergleichen…"
TABLES=(tenant audit_log client document invoice)
ASSERT_OK=1
for t in "${TABLES[@]}"; do
  src_n="$(count_rows "$SRC_URL" "$t")"
  dst_n="$(count_rows "$TARGET_URL" "$t")"
  if [[ "$src_n" != "$dst_n" ]]; then
    echo "  ✗ $t: Quelle=$src_n  Ziel=$dst_n  (ABWEICHUNG)"
    ASSERT_OK=0
  else
    echo "  ✓ $t: $src_n Zeilen (Quelle = Ziel)"
  fi
done
[[ "$ASSERT_OK" -eq 1 ]] || die "Zeilenzahl-Vergleich fehlgeschlagen — Restore unvollständig."

# -----------------------------------------------------------------------------
# 6. Assertion B (compliance-kritisch) — Audit-Hash-Chain auf der Ziel-DB.
#    Bricht die Chain auf der wiederhergestellten DB, ist das Backup für GoBD
#    wertlos. Daher harter Fehler.
# -----------------------------------------------------------------------------
info "Assertion B: verify:chain auf '$TARGET_DB'…"
( cd "$ROOT" && DATABASE_URL="$TARGET_URL" pnpm verify:chain )

# -----------------------------------------------------------------------------
# Erfolg.
# -----------------------------------------------------------------------------
info "Restore-Selbsttest ERFOLGREICH."
echo "  Quelle: $SRC_DBNAME → Ziel: $TARGET_DB"
echo "  Verglichene Tabellen (Zeilen):"
for t in "${TABLES[@]}"; do
  echo "    $t = $(count_rows "$TARGET_URL" "$t")"
done
echo "  Audit-Hash-Chain auf der wiederhergestellten DB: intakt."
