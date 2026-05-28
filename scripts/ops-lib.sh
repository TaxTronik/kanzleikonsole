#!/usr/bin/env bash
# Shared helpers for taxtronik operator scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env"
DC="$ROOT/dc"

info() {
  printf '\n[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  echo "FEHLER: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."
}

load_env() {
  [[ -f "$ENVFILE" ]] || die "$ENVFILE nicht gefunden. Erst .env anlegen oder ./scripts/setup.sh ausfuehren."
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$ENVFILE"
}

require_env() {
  local missing=()
  for key in "$@"; do
    if [[ -z "${!key:-}" ]]; then missing+=("$key"); fi
  done
  if (( ${#missing[@]} > 0 )); then
    die "Pflichtwerte fehlen in .env: ${missing[*]}"
  fi
}

compose() {
  "$DC" "$@"
}

app_port() {
  printf '%s' "${APP_BIND_PORT:-3000}"
}

image_tag() {
  printf '%s' "${TAXTRONIK_VERSION:-latest}"
}

preflight_common() {
  require_cmd docker
  require_cmd node
  require_cmd curl
  [[ -x "$DC" ]] || die "$DC ist nicht ausfuehrbar. Einmal ausfuehren: chmod +x dc scripts/*.sh"
  require_env \
    POSTGRES_PASSWORD TAXTRONIK_APP_PASSWORD AUTH_SECRET \
    S3_ACCESS_KEY S3_SECRET_KEY N8N_HMAC_SECRET N8N_ENCRYPTION_KEY
}

assert_production_env() {
  if [[ "${NODE_ENV:-production}" != "production" ]]; then
    die "NODE_ENV muss fuer diese Operator-Skripte production sein (aktuell: ${NODE_ENV:-unset})."
  fi
  if [[ "${DATABASE_URL:-}" == "${DATABASE_APP_URL:-}" ]]; then
    die "DATABASE_URL und DATABASE_APP_URL duerfen nicht identisch sein."
  fi
}

prisma_cli() {
  local prisma
  prisma="$(find "$ROOT/node_modules" -path '*/prisma/build/index.js' -not -path '*/cache/*' 2>/dev/null | head -1 || true)"
  [[ -n "$prisma" ]] || die "Prisma CLI nicht gefunden. Auf dem Server einmal 'corepack enable && pnpm install --frozen-lockfile' ausfuehren."
  printf '%s' "$prisma"
}

owner_database_url_for_host() {
  printf 'postgresql://taxtronik:%s@127.0.0.1:5432/taxtronik?schema=public' "$POSTGRES_PASSWORD"
}

run_migrations() {
  info "DB-Migrationen anwenden"
  DATABASE_URL="$(owner_database_url_for_host)" \
    node "$(prisma_cli)" migrate deploy --schema "$ROOT/packages/db/prisma/schema.prisma"
}

build_images() {
  local tag
  tag="$(image_tag)"
  info "Docker-Images bauen: taxtronik/web:$tag und taxtronik/worker:$tag"
  docker build -f "$ROOT/infra/docker/Dockerfile.web" -t "taxtronik/web:$tag" "$ROOT"
  docker build -f "$ROOT/infra/docker/Dockerfile.worker" -t "taxtronik/worker:$tag" "$ROOT"
}

start_infra() {
  info "Infra starten"
  compose --infra up -d
}

start_apps() {
  info "App, Worker und n8n starten/neu erzeugen"
  compose up -d --force-recreate --no-deps app worker n8n
}

smoke_health() {
  local url status
  url="http://127.0.0.1:$(app_port)/api/health"
  info "Health-Smoke: $url"
  for _ in {1..30}; do
    status="$(curl -fsS "$url" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{process.exit(1)}})" 2>/dev/null || true)"
    if [[ "$status" == "ok" || "$status" == "degraded" ]]; then
      echo "Health: $status"
      return 0
    fi
    sleep 2
  done
  compose ps
  compose logs app --tail 80 || true
  die "Health-Smoke fehlgeschlagen."
}

run_backup() {
  require_cmd pnpm
  info "Backup starten"
  (cd "$ROOT" && pnpm --filter @taxtronik/web backup:run)
}
