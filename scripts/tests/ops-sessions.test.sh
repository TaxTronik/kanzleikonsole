#!/usr/bin/env bash
# Fachkatalog: ACCESS-TENANT-RLS-001
# ./taxtronik revoke-all-sessions (CVP-Nachprüfung 20.11.2026, Befund 2): setzt
# den globalen Widerrufsstichtag per EVAL im Redis-Container, bestätigt nur nach
# belastbarem Nachlesen und bricht sonst ohne Erfolgsmeldung ab. `docker` ist
# eine Attrappe; die Gleichheit des Lua-Skripts mit dem Anwendungscode prüft
# packages/crypto/src/__tests__/session-revocation.test.ts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

# Läuft in einer Subshell, damit `die` (exit 1) den Testlauf nicht beendet.
run_case() {
  local name="$1" running="$2" eval_reply="$3" get_reply="$4" ttl_reply="$5"
  (
    # shellcheck source=../ops-lib.sh
    source "$REPO_ROOT/scripts/ops-lib.sh"
    docker() {
      printf '%s\n' "$*" >>"$TMP_DIR/$name.calls"
      if [[ "$1" == inspect ]]; then
        printf '%s\n' "$running"
        return 0
      fi
      case "$*" in
        *" EVAL "*)
          [[ "$eval_reply" != FAIL ]] || return 1
          printf '%s\n' "$eval_reply"
          ;;
        *" GET revoke:all") printf '%s\n' "$get_reply" ;;
        *" TTL revoke:all") printf '%s\n' "$ttl_reply" ;;
        *) return 99 ;;
      esac
    }
    cmd_revoke_all_sessions
  ) >"$TMP_DIR/$name.out" 2>&1
}

# 1. Erfolg: EVAL mit revoke:all und 30 Tagen TTL, danach nachgelesen.
run_case ok true OK 1795194697960 2591999 || fail "Erfolgsfall brach ab: $(cat "$TMP_DIR/ok.out")"
grep -Fq 'exec taxtronik-redis redis-cli --raw EVAL' "$TMP_DIR/ok.calls" || fail 'kein EVAL im Redis-Container'
grep -Fq ' 1 revoke:all 2592000' "$TMP_DIR/ok.calls" || fail 'EVAL ohne Schluessel revoke:all und TTL 2592000'
grep -Fq "redis.call('TIME')" "$TMP_DIR/ok.calls" || fail 'Skript nutzt nicht die Redis-Uhr'
grep -Fq 'Alle bis 1795194697960 ms' "$TMP_DIR/ok.out" || fail 'Erfolgsmeldung ohne Stichtag'

# 2. Fehlschläge: nie eine Erfolgsmeldung.
for spec in \
  'stopped|false|OK|1795194697960|2591999|laeuft nicht' \
  'evalfail|true|FAIL|1795194697960|2591999|fehlgeschlagen' \
  'unexpected|true|QUEUED|1795194697960|2591999|unerwartete Redis-Antwort' \
  'missing|true|OK||-2|nicht belastbar' \
  'shortttl|true|OK|1795194697960|60|nicht belastbar'; do
  IFS='|' read -r name running eval_reply get_reply ttl_reply expected <<<"$spec"
  if run_case "$name" "$running" "$eval_reply" "$get_reply" "$ttl_reply"; then
    fail "$name: Kommando meldete Erfolg"
  fi
  grep -Fq "$expected" "$TMP_DIR/$name.out" || fail "$name: erwartete Meldung fehlt: $expected ($(cat "$TMP_DIR/$name.out"))"
  if grep -Fq 'sind widerrufen' "$TMP_DIR/$name.out"; then fail "$name: Erfolgsmeldung trotz Fehler"; fi
done

# 3. Zusätzliche Argumente werden abgewiesen, bevor Redis angesprochen wird.
if (
  # shellcheck source=../ops-lib.sh
  source "$REPO_ROOT/scripts/ops-lib.sh"
  docker() { printf 'called\n' >>"$TMP_DIR/args.calls"; }
  cmd_revoke_all_sessions --force
) >"$TMP_DIR/args.out" 2>&1; then
  fail 'zusaetzliches Argument akzeptiert'
fi
[[ ! -e "$TMP_DIR/args.calls" ]] || fail 'Redis trotz ungueltiger Argumente angesprochen'

printf 'ok: ops-sessions (7 Faelle)\n'
