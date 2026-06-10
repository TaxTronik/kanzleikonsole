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

# Registry-Pull-Modus: TAXTRONIK_IMAGE_PREFIX enthält einen Registry-Pfad
# (z. B. git.hirschmann-koxha.de/taxtronik) — erkennbar am '/'. Ohne Slash
# (Default `taxtronik`) bauen die Skripte lokal aus dem Checkout.
images_from_registry() {
  [[ "${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" == */* ]]
}

require_release_version() {
  # Kein latest/dev-Fallback in Produktion: Deploy und Rollback brauchen einen
  # eindeutig benannten Stand — sonst ist nie nachvollziehbar, welche Version
  # gerade läuft und auf welchen Tag man zurück kann.
  if [[ -z "${TAXTRONIK_VERSION:-}" ]]; then
    die "TAXTRONIK_VERSION ist nicht in der .env gesetzt. Registry-Pull: auf das Release pinnen (z. B. TAXTRONIK_VERSION=1.4.0). Lokaler Build: z. B. TAXTRONIK_VERSION=$(date +%Y-%m-%d)."
  fi
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

run_migrations() {
  # One-Shot-Container statt Host-Prisma: das Worker-Image enthält Prisma-CLI
  # und Migrationen, die Owner-DB-URL kommt aus der Compose-Definition. Damit
  # läuft exakt derselbe Pfad wie bei `./dc up`, und der Server braucht für
  # Migrationen weder node_modules noch einen publizierten Postgres-Port.
  info "DB-Migrationen anwenden (migrate-Container)"
  compose run --rm migrate
}

build_images() {
  local prefix tag sha
  prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}"
  tag="$(image_tag)"
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  info "Docker-Images bauen: $prefix/web:$tag und $prefix/worker:$tag"
  docker build -f "$ROOT/infra/docker/Dockerfile.web" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/web:$tag" "$ROOT"
  docker build -f "$ROOT/infra/docker/Dockerfile.worker" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/worker:$tag" "$ROOT"
}

pull_images() {
  info "Images aus der Registry ziehen: ${TAXTRONIK_IMAGE_PREFIX}/{web,worker}:$(image_tag)"
  compose pull app worker
}

# Pull-before-Stop: Images werden beschafft, solange der alte Stand noch läuft —
# die Downtime beim Update reduziert sich auf den reinen Container-Neustart.
provide_images() {
  if images_from_registry; then
    pull_images
  else
    build_images
  fi
}

backup_before_migrations() {
  # Sicherheitsnetz vor `migrate deploy` (Prisma ist forward-only, kein
  # automatischer Rollback). Erst ab dem zweiten Deploy sinnvoll — beim
  # Erstdeploy existiert noch kein Schema, das man sichern könnte.
  local migrated
  migrated="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || true)"
  if [[ "$migrated" == "t" ]]; then
    run_backup
  else
    info "Erstdeploy erkannt (keine _prisma_migrations-Tabelle) — Backup vor Migration entfällt."
  fi
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
    # KEIN curl -f: der Health-Endpoint liefert bei 'degraded' bewusst HTTP 503
    # mit JSON-Body. Mit -f würde curl den 503-Body verwerfen und 'degraded'
    # (App läuft, eine Abhängigkeit flackert) wäre nie als Erfolg erkennbar.
    status="$(curl -sS "$url" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{process.exit(1)}})" 2>/dev/null || true)"
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
