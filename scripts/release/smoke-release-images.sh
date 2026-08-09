#!/usr/bin/env bash
# Startet exakt die lokal geladenen Release-Images als vollständigen Stack.
# Kein Registry-Push darf vor diesem Gate stattfinden.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$ROOT/infra/compose/docker-compose.yml"
APP="$ROOT/infra/compose/docker-compose.app.yml"

usage() {
  cat <<'EOF'
Usage: smoke-release-images.sh --web-image REF --worker-image REF --expected-revision SHA

Optionale ENV:
  TAXTRONIK_SMOKE_TIMEOUT   Compose-Wartezeit in Sekunden (Default: 480)
  TAXTRONIK_SMOKE_APP_PORT  lokaler App-Port (Default: 3000)
EOF
}

WEB_IMAGE=""
WORKER_IMAGE=""
EXPECTED_REVISION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --web-image) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; WEB_IMAGE="$2"; shift 2 ;;
    --worker-image) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; WORKER_IMAGE="$2"; shift 2 ;;
    --expected-revision) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; EXPECTED_REVISION="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unbekanntes Argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$WEB_IMAGE" && -n "$WORKER_IMAGE" && -n "$EXPECTED_REVISION" ]] || {
  usage >&2
  exit 2
}

for ref in "$WEB_IMAGE" "$WORKER_IMAGE"; do
  docker image inspect "$ref" >/dev/null 2>&1 || {
    echo "Release-Image ist nicht lokal geladen: $ref" >&2
    exit 1
  }
done

docker run --rm --entrypoint sh "$WORKER_IMAGE" -eu -c '
  test "$(id -u)" = "1000"
  test -r /app/packages/db/scripts/migrate-deploy.sh
  test -r /app/packages/db/scripts/migrate-deploy.mjs
  test -r /app/packages/db/scripts/check-migration-line-endings.mjs
  test -r /app/packages/db/scripts/inspect-migration-recovery.mjs
  test -r /app/packages/db/scripts/verify-migration-ledger.mjs
  test -r /app/packages/db/prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql
  test ! -w /app/packages/db/scripts/migrate-deploy.sh
  test ! -w /app/packages/db/scripts/migrate-deploy.mjs
  test ! -w /app/packages/db/scripts/check-migration-line-endings.mjs
  test ! -w /app/packages/db/scripts/inspect-migration-recovery.mjs
  test ! -w /app/packages/db/scripts/verify-migration-ledger.mjs
  test ! -w /app/packages/db/prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql
' || {
  echo "Worker-Image hat fuer USER node unsichere Migrationsdateirechte." >&2
  exit 1
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/taxtronik-release-smoke.XXXXXX")"
ENV_FILE="$TMP_DIR/smoke.env"
OVERRIDE="$TMP_DIR/smoke.override.yml"
BACKUP_DIR="$TMP_DIR/backups"
mkdir -p "$BACKUP_DIR"

export TAXTRONIK_SMOKE_WEB_IMAGE="$WEB_IMAGE"
export TAXTRONIK_SMOKE_WORKER_IMAGE="$WORKER_IMAGE"
SMOKE_TIMEOUT="${TAXTRONIK_SMOKE_TIMEOUT:-480}"
SMOKE_APP_PORT="${TAXTRONIK_SMOKE_APP_PORT:-3000}"

cat >"$ENV_FILE" <<EOF
NODE_ENV=production
TAXTRONIK_VERSION=0.0.0-smoke
POSTGRES_PASSWORD=smoke-owner-password-32-characters-long
TAXTRONIK_APP_PASSWORD=smoke-app-password-32-characters-long
N8N_DB_PASSWORD=smoke-n8n-db-password-32-characters
DATABASE_URL=postgresql://taxtronik:smoke-owner-password-32-characters-long@localhost:5432/taxtronik?schema=public
DATABASE_APP_URL=postgresql://taxtronik_app:smoke-app-password-32-characters-long@localhost:5432/taxtronik?schema=public
REDIS_URL=redis://localhost:6380
AUTH_SECRET=smoke-auth-secret-with-more-than-thirty-two-characters
SECRET_BOX_KEY=smoke-secret-box-key-with-more-than-thirty-two-characters
NEXTAUTH_URL=https://staff.release-smoke.invalid
NEXTAUTH_TRUST_HOST=true
TRUST_PROXY_REQUIRED=false
PORTAL_PUBLIC_URL=https://portal.release-smoke.invalid
STAFF_COOKIE_DOMAIN=staff.release-smoke.invalid
PORTAL_COOKIE_DOMAIN=portal.release-smoke.invalid
S3_ACCESS_KEY=release-smoke-access
S3_SECRET_KEY=smoke-s3-secret-with-more-than-thirty-two-characters
N8N_HMAC_SECRET=smoke-n8n-hmac-with-more-than-thirty-two-characters
N8N_ENCRYPTION_KEY=smoke-n8n-encryption-key-32-chars
SMTP_HOST=smtp.release-smoke.invalid
SMTP_PORT=587
SMTP_FROM=release-smoke@example.invalid
APP_BIND=127.0.0.1
APP_BIND_PORT=$SMOKE_APP_PORT
N8N_BIND=127.0.0.1
BACKUP_HOST_DIR=$BACKUP_DIR
EOF

cat >"$OVERRIDE" <<'EOF'
services:
  app:
    image: ${TAXTRONIK_SMOKE_WEB_IMAGE:?web smoke image missing}
  worker:
    image: ${TAXTRONIK_SMOKE_WORKER_IMAGE:?worker smoke image missing}
  migrate:
    image: ${TAXTRONIK_SMOKE_WORKER_IMAGE:?worker smoke image missing}
  backup-dir-init:
    image: ${TAXTRONIK_SMOKE_WORKER_IMAGE:?worker smoke image missing}
EOF

# Ein eigener Projektname verhindert, dass `down -v --remove-orphans` auf
# wiederverwendeten Runnern Ressourcen eines fremden Compose-Projekts trifft.
SMOKE_PROJECT_NAME="taxtronik-release-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
COMPOSE=(docker compose --project-name "$SMOKE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$BASE" -f "$APP" -f "$OVERRIDE")

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ $status -ne 0 ]]; then
    echo "--- Release-Image-Smoke fehlgeschlagen: Containerstatus ---" >&2
    "${COMPOSE[@]}" ps >&2 || true
    echo "--- Release-Image-Smoke: letzte Logs ---" >&2
    "${COMPOSE[@]}" logs --no-color --tail 160 app worker migrate n8n postgres redis seaweedfs clamav >&2 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

if docker ps -a --format '{{.Names}}' | grep -q '^taxtronik-'; then
  echo "Bestehende taxtronik-Container gefunden; Smoke verweigert destruktives Aufräumen." >&2
  docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep -E '(^NAMES|^taxtronik-)' >&2 || true
  exit 1
fi

"${COMPOSE[@]}" config --quiet

# Gepinnte Infrastruktur darf einmalig geladen werden. Danach läuft `up` mit
# --pull never, sodass Web/Worker garantiert die eben gebauten lokalen Images
# und nicht gleichnamige Registry-Artefakte verwenden.
"${COMPOSE[@]}" pull postgres redis seaweedfs seaweedfs-init clamav n8n
"${COMPOSE[@]}" up --pull never -d --wait --wait-timeout "$SMOKE_TIMEOUT" app worker n8n

payload="$(curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${SMOKE_APP_PORT}/api/health")"
printf '%s' "$payload" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || {
  echo "Readiness meldet nicht status=ok: $payload" >&2
  exit 1
}

docker logs taxtronik-worker 2>&1 | grep -q 'worker: ready' || {
  echo "Worker-Ready-Marker fehlt." >&2
  exit 1
}

expected_web_id="$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE")"
expected_worker_id="$(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")"
actual_web_id="$(docker inspect --format '{{.Image}}' taxtronik-app)"
actual_worker_id="$(docker inspect --format '{{.Image}}' taxtronik-worker)"
[[ "$actual_web_id" == "$expected_web_id" ]] || {
  echo "Web-Container nutzt falsches Image: $actual_web_id != $expected_web_id" >&2
  exit 1
}
[[ "$actual_worker_id" == "$expected_worker_id" ]] || {
  echo "Worker-Container nutzt falsches Image: $actual_worker_id != $expected_worker_id" >&2
  exit 1
}

for container in taxtronik-app taxtronik-worker; do
  revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")"
  [[ "$revision" == "$EXPECTED_REVISION" ]] || {
    echo "$container trägt falsches Revision-Label: $revision != $EXPECTED_REVISION" >&2
    exit 1
  }
done

echo "OK: Release-Images als vollständiger Stack healthy (Revision $EXPECTED_REVISION)."
