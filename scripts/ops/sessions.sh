#!/usr/bin/env bash
# =============================================================================
# Sitzungen — Teil der Operator-CLI (./taxtronik).
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Hilfsfunktionen (die, info, require_cmd).
#
# ./taxtronik revoke-all-sessions setzt den globalen Widerrufsstichtag
# `revoke:all` auf die Redis-Serverzeit. Danach sind alle bis dahin
# ausgestellten Mitarbeiter- und Portalsitzungen ungültig; neue Anmeldungen
# funktionieren sofort.
#
# Pflicht nach jedem Zurückspielen von `redis_data` und nach einem
# Redis-Failover: Ein älterer Redis-Stand enthält spätere Abmeldungen und
# Sperren nicht mehr. Ohne diesen Schritt würden bereits widerrufene Sitzungen
# bis zum Ende ihrer 24-Stunden-Lebensdauer wieder gültig
# (docs/operations/disaster-recovery.md).
#
# Das Lua-Skript ist wörtlich ADVANCE_REVOCATION aus
# packages/crypto/src/session-revocation.ts (monoton, Redis-Uhr, 30 Tage TTL);
# packages/crypto/src/__tests__/session-revocation.test.ts prüft die Gleichheit.
# =============================================================================

TAXTRONIK_REDIS_CONTAINER="${TAXTRONIK_REDIS_CONTAINER:-taxtronik-redis}"
SESSION_REVOCATION_TTL_SEC=2592000

cmd_revoke_all_sessions() {
  [[ $# -eq 0 ]] || die "Nutzung: ./taxtronik revoke-all-sessions"
  require_cmd docker
  local lua result cutoff ttl
  lua="$(cat <<'LUA'
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)

local stored = redis.call('GET', KEYS[1])
local incoming = nowMs
if stored then
  local current = tonumber(stored)
  if not current or current <= 0 or current > 9007199254740991 or current ~= math.floor(current) then
    return redis.error_reply('invalid existing revocation timestamp')
  end
  if current > incoming then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return 'OK'
  end
end
return redis.call('SET', KEYS[1], string.format('%.0f', incoming), 'EX', ARGV[1])
LUA
)"
  [[ "$(docker inspect --format '{{.State.Running}}' "$TAXTRONIK_REDIS_CONTAINER" 2>/dev/null || true)" == "true" ]] ||
    die "Redis-Container $TAXTRONIK_REDIS_CONTAINER laeuft nicht. Erst ./taxtronik --infra up -d redis."
  result="$(docker exec "$TAXTRONIK_REDIS_CONTAINER" redis-cli --raw EVAL "$lua" 1 revoke:all "$SESSION_REVOCATION_TTL_SEC")" ||
    die "Globaler Sitzungswiderruf fehlgeschlagen; es wurde nichts bestaetigt."
  [[ "$result" == "OK" ]] || die "Globaler Sitzungswiderruf: unerwartete Redis-Antwort: $result"
  cutoff="$(docker exec "$TAXTRONIK_REDIS_CONTAINER" redis-cli --raw GET revoke:all)" ||
    die "Globaler Sitzungswiderruf konnte nicht nachgelesen werden."
  ttl="$(docker exec "$TAXTRONIK_REDIS_CONTAINER" redis-cli --raw TTL revoke:all)" ||
    die "Globaler Sitzungswiderruf konnte nicht nachgelesen werden."
  [[ "$cutoff" =~ ^[1-9][0-9]{12,15}$ && "$ttl" =~ ^[0-9]+$ && "$ttl" -gt 86400 ]] ||
    die "Globaler Sitzungswiderruf nicht belastbar gespeichert (Wert: $cutoff, TTL: $ttl)."
  info "Alle bis $cutoff ms (Redis-Uhr) ausgestellten Sitzungen sind widerrufen; Stichtag gilt noch ${ttl} s."
}
