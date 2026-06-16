#!/usr/bin/env bash
# =============================================================================
# Shared helpers für die taxtronik Operator-CLI (./taxtronik).
#
# Wird von ./taxtronik gesourcet. Enthält:
#   - .env-Laden + Secret-Generierung (ensure_secret)
#   - docker-compose-Wrapper (compose) — ehemals ./dc, jetzt eingebettet
#   - doctor: vorab .env-Validierung statt telemetrischem Mid-Deploy-Abbruch
#   - bootstrap: Prod-Erstinstall in einem Kommando
#   - deploy/update/backup/rollback: die Operator-Abläufe
#
# Dev/Prod-Trennung: auf dem Server läuft NUR Prod. .env auf dem Server ist
# immer eine Prod-.env (erzeugt via ./taxtronik bootstrap). Das Dev-setup
# (scripts/setup.sh) ist ausschließlich für Entwickler-Maschinen und erzeugt
# bewusst eine DEV-.env — genau das war früher die Quelle der "deploy meckert"-
# Kollision, weil beide in dieselbe .env schrieben.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env"
BASE="$ROOT/infra/compose/docker-compose.yml"
APP="$ROOT/infra/compose/docker-compose.app.yml"
DEV="$ROOT/infra/compose/docker-compose.dev.yml"
S3_TEMPLATE="$ROOT/infra/scripts/seaweedfs-s3.template.json"
S3_GENERATED="$ROOT/infra/scripts/seaweedfs-s3.generated.json"
STATE="$ROOT/.taxtronik.state"

# ---------------------------------------------------------------------------
# Ausgabe-Helper
# ---------------------------------------------------------------------------
info() { printf '\n[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] !! %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { echo "FEHLER: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."; }

# ---------------------------------------------------------------------------
# .env laden / schreiben
# ---------------------------------------------------------------------------
load_env() {
  [[ -f "$ENVFILE" ]] || die "$ENVFILE nicht gefunden. Prod: ./taxtronik bootstrap. Dev: ./scripts/setup.sh"
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"; value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
    export "$key=$value"
  done < "$ENVFILE"
  return 0
}

require_env() {
  local missing=()
  for key in "$@"; do [[ -z "${!key:-}" ]] && missing+=("$key"); done
  (( ${#missing[@]} > 0 )) && die "Pflichtwerte fehlen in .env: ${missing[*]}"
  return 0   # explizit: (( 0 )) && ... gibt sonst Status 1 -> set -e bricht ab
}

# Wert aus .env lesen OHNE shell-Variablen (für Render/Checks vor load_env).
get_env() {
  local key="$1"
  [[ -f "$ENVFILE" ]] || return 0
  grep -E "^${key}=" "$ENVFILE" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true
}

# N-1: base64url statt Standard-Base64 — Werte landen u. a. in der Postgres-
# URL; ein '/' im Passwort würde den URL-Password-Teil terminieren.
rand_b64() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '=\n' | tr '+/' '-_'
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '=\n' | tr '+/' '-_'
  fi
}

set_env() {
  local key="$1" value="$2"
  local esc; esc="$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')"
  if grep -qE "^${key}=" "$ENVFILE"; then
    if sed --version >/dev/null 2>&1; then
      sed -i -E "s|^${key}=.*$|${key}=${esc}|" "$ENVFILE"
    else
      sed -i '' -E "s|^${key}=.*$|${key}=${esc}|" "$ENVFILE"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENVFILE"
  fi
}

ensure_secret() {
  local key="$1" bytes="$2"
  if [[ -z "$(get_env "$key")" ]]; then
    set_env "$key" "$(rand_b64 "$bytes")"
    info "$key generiert."
  fi
}

# ---------------------------------------------------------------------------
# docker-compose-Wrapper (ehemals ./dc)
# ---------------------------------------------------------------------------
# SeaweedFS-S3-Config aus .env rendern. Docker macht aus einem fehlenden
# Bind-Mount-Source ein leeres Verzeichnis — SeaweedFS stirbt sonst mit
# "s3.json: is a directory". Idempotent, läuft bei jedem compose-Aufruf (<10ms).
render_s3_config() {
  [[ -f "$S3_TEMPLATE" ]] || die "$S3_TEMPLATE fehlt."
  if [[ -d "$S3_GENERATED" ]]; then rmdir "$S3_GENERATED" 2>/dev/null || rm -rf "$S3_GENERATED"; fi
  local ak sk
  ak="$(get_env S3_ACCESS_KEY)"; sk="$(get_env S3_SECRET_KEY)"
  [[ -n "$ak" && -n "$sk" ]] || die "S3_ACCESS_KEY/S3_SECRET_KEY nicht in .env."
  sed -e "s|__S3_ACCESS_KEY__|${ak}|" -e "s|__S3_SECRET_KEY__|${sk}|" "$S3_TEMPLATE" > "$S3_GENERATED"
  chmod 644 "$S3_GENERATED"   # unprivilegierter Container-User muss (ro) lesen
}

# compose [--infra] <docker-compose-subcommand> ...
#   --infra: nur Basis-Services (Postgres/Redis/SeaweedFS/ClamAV), ohne app/worker/n8n
compose() {
  render_s3_config
  if [[ "${1:-}" == "--infra" ]]; then
    shift
    docker compose -f "$BASE" --env-file "$ENVFILE" "$@"
  else
    docker compose -f "$BASE" -f "$APP" --env-file "$ENVFILE" "$@"
  fi
}

# ---------------------------------------------------------------------------
# Versions-/Image-Logik
# ---------------------------------------------------------------------------
app_port() { printf '%s' "${APP_BIND_PORT:-3000}"; }
image_tag() { printf '%s' "${TAXTRONIK_VERSION:-latest}"; }

# Registry-Pull-Modus: TAXTRONIK_IMAGE_PREFIX mit '/' => fertige Release-Images
# aus der Registry (CI-gebaut). Ohne '/' (Default `taxtronik`) => Lokalbuild.
images_from_registry() { [[ "${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" == */* ]]; }

require_release_version() {
  [[ -n "${TAXTRONIK_VERSION:-}" ]] || \
    die "TAXTRONIK_VERSION fehlt in .env. Auf ein Release pinnen (z. B. TAXTRONIK_VERSION=1.4.0) — oder './taxtronik bootstrap' bzw. 'doctor --fix' fuer ein Erstdeploy."
}

assert_production_env() {
  [[ "${NODE_ENV:-production}" == "production" ]] || \
    die "NODE_ENV muss fuer Operator-Skripte 'production' sein (aktuell: ${NODE_ENV:-unset}). Server nutzt ./taxtronik bootstrap, nicht scripts/setup.sh."
  [[ "${DATABASE_URL:-}" != "${DATABASE_APP_URL:-}" ]] || \
    die "DATABASE_URL und DATABASE_APP_URL duerfen nicht identisch sein (RLS-Backstop)."
}

preflight_common() {
  require_cmd docker
  require_cmd node
  require_cmd curl
  require_env \
    POSTGRES_PASSWORD TAXTRONIK_APP_PASSWORD AUTH_SECRET \
    S3_ACCESS_KEY S3_SECRET_KEY N8N_HMAC_SECRET N8N_ENCRYPTION_KEY N8N_DB_PASSWORD
}

# ---------------------------------------------------------------------------
# doctor — vorab .env-Validierung. Liefert eine Klartext-Liste (OK/FEHLT/
# SCHWACH/WARN) mit Hinweisen, statt mitten im Deploy an ${VAR:?} oder
# assert_production_env abzubrechen. --fix generiert fehlende Secrets und
# setzt sichere Prod-Defaults. Rückgabe: 0 ok, 1 bei blockierenden Fehlern.
# ---------------------------------------------------------------------------
_DOCTOR_ERRS=0; _DOCTOR_WARNS=0
_dr_row()    { printf '  %-8s %-22s %s\n' "$1" "$2" "$3"; }
_dr_secret() {
  local key="$1" min="$2" val="${!1:-}"
  if [[ -z "$val" ]]; then
    _dr_row "FEHLT" "$key" "leer -> './taxtronik doctor --fix'"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif (( ${#val} < min )); then
    _dr_row "SCHWACH" "$key" "nur ${#val} Zeichen (< $min)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_row "OK" "$key" "${#val} Zeichen"
  fi
}

doctor() {
  local fix=0
  [[ "${1:-}" == "--fix" ]] && fix=1

  [[ -f "$ENVFILE" ]] || { echo "FEHLER: $ENVFILE fehlt. Prod: ./taxtronik bootstrap" >&2; return 1; }

  if [[ $fix -eq 1 ]]; then
    info "doctor --fix: Secrets + Prod-Defaults ergaenzen"
    [[ "$(get_env NODE_ENV)" != "production" ]] && { set_env NODE_ENV production; info "NODE_ENV=production gesetzt."; }
    [[ -z "$(get_env TAXTRONIK_VERSION)" ]] && { set_env TAXTRONIK_VERSION "$(date +%Y-%m-%d)"; info "TAXTRONIK_VERSION=$(date +%Y-%m-%d) gesetzt (spater auf Release pinnen)."; }
    # NEXTAUTH_TRUST_HOST ist in Produktion Pflicht (env.ts:238). Default true:
    # der Stack steht ohnehin hinter einem Reverse-Proxy (P-4), der die Host-
    # Header setzt/filtert. Wer ohne Proxy direkt ins Netz bindet, muss das
    # nachtraeglich auf false setzen.
    [[ -z "$(get_env NEXTAUTH_TRUST_HOST)" ]] && { set_env NEXTAUTH_TRUST_HOST true; info "NEXTAUTH_TRUST_HOST=true gesetzt (Prod hinter Reverse-Proxy)."; }
    ensure_secret AUTH_SECRET 32
    ensure_secret N8N_HMAC_SECRET 32
    ensure_secret N8N_ENCRYPTION_KEY 24
    ensure_secret POSTGRES_PASSWORD 24
    ensure_secret TAXTRONIK_APP_PASSWORD 24
    ensure_secret S3_SECRET_KEY 32
    ensure_secret N8N_DB_PASSWORD 24
  fi

  load_env
  _DOCTOR_ERRS=0; _DOCTOR_WARNS=0
  info "doctor — .env-Validierung ($(basename "$ENVFILE"))"

  _dr_secret AUTH_SECRET 32
  _dr_secret N8N_HMAC_SECRET 32
  _dr_secret N8N_ENCRYPTION_KEY 24
  _dr_secret POSTGRES_PASSWORD 24
  _dr_secret TAXTRONIK_APP_PASSWORD 24
  _dr_secret S3_SECRET_KEY 32
  _dr_secret N8N_DB_PASSWORD 24
  if [[ -z "${S3_ACCESS_KEY:-}" ]]; then _dr_row "FEHLT" "S3_ACCESS_KEY" "leer"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1)); else _dr_row "OK" "S3_ACCESS_KEY" "$S3_ACCESS_KEY"; fi

  if [[ "${NODE_ENV:-}" != "production" ]]; then
    _dr_row "FEHLT" "NODE_ENV" "='${NODE_ENV:-unset}' (muss production)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else _dr_row "OK" "NODE_ENV" "production"; fi

  if [[ -z "${DATABASE_URL:-}" || -z "${DATABASE_APP_URL:-}" ]]; then
    _dr_row "FEHLT" "DATABASE_URL/APP_URL" "nicht gesetzt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$DATABASE_URL" == "$DATABASE_APP_URL" ]]; then
    _dr_row "FEHLT" "DATABASE_URL" "== DATABASE_APP_URL (RLS-Backstop!)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else _dr_row "OK" "DATABASE_URL/APP_URL" "unterschiedlich (ok)"; fi

  if [[ -z "${TAXTRONIK_VERSION:-}" ]]; then
    _dr_row "FEHLT" "TAXTRONIK_VERSION" "Release pinnen (z. B. 1.4.0)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$TAXTRONIK_VERSION" == "latest" || "$TAXTRONIK_VERSION" == "dev" ]]; then
    _dr_row "WARN" "TAXTRONIK_VERSION" "='$TAXTRONIK_VERSION' (auf Release pinnen)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else _dr_row "OK" "TAXTRONIK_VERSION" "$TAXTRONIK_VERSION"; fi

  if [[ -z "${NEXTAUTH_URL:-}" ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "leer"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ "$NEXTAUTH_URL" == *localhost* || "$NEXTAUTH_URL" == *127.0.0.1* ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "=$NEXTAUTH_URL (oeffentliche URL setzen)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else _dr_row "OK" "NEXTAUTH_URL" "$NEXTAUTH_URL"; fi

  # NEXTAUTH_TRUST_HOST ist in Produktion Pflicht (env.ts-Cross-Field-Check).
  if [[ "${NODE_ENV:-}" == "production" && -z "${NEXTAUTH_TRUST_HOST:-}" ]]; then
    _dr_row "FEHLT" "NEXTAUTH_TRUST_HOST" "in Prod Pflicht (true/false)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else _dr_row "OK" "NEXTAUTH_TRUST_HOST" "${NEXTAUTH_TRUST_HOST:-true}"; fi

  # Risk-Layer (optional): URL und Token MUSS als Paar gesetzt werden (beide
  # oder keines), sonst wirft die ENV-Validierung. Token min 32 (Secret32).
  local rl_url="${RISK_LAYER_URL:-}" rl_tok="${RISK_LAYER_TOKEN:-}"
  if [[ -n "$rl_url" && -z "$rl_tok" ]]; then
    _dr_row "FEHLT" "RISK_LAYER_TOKEN" "URL gesetzt, Token fehlt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -z "$rl_url" && -n "$rl_tok" ]]; then
    _dr_row "FEHLT" "RISK_LAYER_URL" "Token gesetzt, URL fehlt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -n "$rl_url" && ${#rl_tok} -lt 32 ]]; then
    _dr_row "SCHWACH" "RISK_LAYER_TOKEN" "nur ${#rl_tok} Zeichen (< 32)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ -n "$rl_url" ]]; then
    _dr_row "OK" "RISK_LAYER" "konfiguriert (URL + Token)"
  else _dr_row "OK" "RISK_LAYER" "inaktiv (ok)"; fi

  [[ -z "${SMTP_HOST:-}" ]] && { _dr_row "WARN" "SMTP_HOST" "leer (kein Mail-Versand)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1)); }
  [[ -z "${PORTAL_PUBLIC_URL:-}" ]] && { _dr_row "WARN" "PORTAL_PUBLIC_URL" "leer (Single-Host: ok)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1)); }

  local staff_dom="${STAFF_COOKIE_DOMAIN:-}" portal_dom="${PORTAL_COOKIE_DOMAIN:-}"
  if [[ -z "$staff_dom" && -z "$portal_dom" ]]; then
    _dr_row "WARN" "COOKIE_DOMAINS" "leer (Single-Host; Subdomain-Trennung empfohlen)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ -z "$staff_dom" || -z "$portal_dom" ]]; then
    _dr_row "FEHLT" "COOKIE_DOMAINS" "STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN gemeinsam setzen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -z "${PORTAL_PUBLIC_URL:-}" ]]; then
    _dr_row "FEHLT" "PORTAL_PUBLIC_URL" "bei Cookie-Domain-Trennung Pflicht"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$staff_dom" == "$portal_dom" ]]; then
    _dr_row "FEHLT" "COOKIE_DOMAINS" "Staff/Portal muessen unterschiedliche Subdomains sein"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$staff_dom" == .* || "$portal_dom" == .* ]]; then
    _dr_row "FEHLT" "COOKIE_DOMAINS" "keine Parent-Domain mit fuehrendem Punkt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$staff_dom" == *"://"* || "$portal_dom" == *"://"* || "$staff_dom" == *"/"* || "$portal_dom" == *"/"* || "$staff_dom" == *":"* || "$portal_dom" == *":"* ]]; then
    _dr_row "FEHLT" "COOKIE_DOMAINS" "nur Hostnames, keine URLs/Pfade/Ports"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "COOKIE_DOMAINS" "$staff_dom / $portal_dom"
  fi

  echo
  if (( _DOCTOR_ERRS > 0 )); then
    echo "  -> $_DOCTOR_ERRS Fehler, $_DOCTOR_WARNS Warnung(en). Blockierend — erst beheben."
    [[ $fix -eq 0 ]] && echo "  Tipp: './taxtronik doctor --fix' generiert fehlende Secrets."
    return 1
  fi
  echo "  -> $_DOCTOR_WARNS Warnung(en). Bereit zum Deploy."
  return 0
}

# ---------------------------------------------------------------------------
# Build / Pull / Migrate / Start / Smoke / Backup
# ---------------------------------------------------------------------------
build_images() {
  local prefix tag sha
  prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}"
  tag="$(image_tag)"
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  export DOCKER_BUILDKIT=1   # BuildKit aktivieren fuer --mount=type=cache (Dockerfile.web/.worker)
  info "Docker-Images bauen: $prefix/web:$tag und $prefix/worker:$tag"
  docker build -f "$ROOT/infra/docker/Dockerfile.web" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/web:$tag" "$ROOT"
  docker build -f "$ROOT/infra/docker/Dockerfile.worker" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/worker:$tag" "$ROOT"
}

pull_images() {
  info "Images aus Registry ziehen: ${TAXTRONIK_IMAGE_PREFIX}/{web,worker}:$(image_tag)"
  compose pull app worker
}

# Pull-before-Stop: Images beschaffen, waehrend der alte Stand noch laeuft —
# Downtime beim Update reduziert sich auf den reinen Container-Neustart.
provide_images() { if images_from_registry; then pull_images; else build_images; fi; }

run_migrations() {
  # One-Shot-Container statt Host-Prisma: das Worker-Image enthaelt Prisma-CLI
  # + Migrationen. Der Server braucht fuer Migrationen weder node_modules noch
  # einen publizierten Postgres-Port.
  info "DB-Migrationen anwenden (migrate-Container)"
  compose run --rm migrate
}

backup_before_migrations() {
  # Sicherheitsnetz vor migrate deploy (Prisma ist forward-only). Erst ab dem
  # zweiten Deploy sinnvoll — beim Erstdeploy existiert noch kein Schema.
  local migrated
  migrated="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || true)"
  if [[ "$migrated" == "t" ]]; then run_backup
  else info "Erstdeploy erkannt (keine _prisma_migrations) — Backup vor Migration entfaellt."; fi
}

start_infra() { info "Infra starten"; compose --infra up -d; }
start_apps()  { info "App, Worker und n8n starten/neu erzeugen"; compose up -d --force-recreate --no-deps app worker n8n; }

smoke_health() {
  local url status
  url="http://127.0.0.1:$(app_port)/api/health"
  info "Health-Smoke: $url"
  for _ in {1..30}; do
    # KEIN curl -f: der Health-Endpoint liefert bei 'degraded' bewusst HTTP 503
    # mit JSON-Body. Mit -f wuerde curl den Body verwerfen und 'degraded' waere
    # nie als Erfolg erkennbar.
    status="$(curl -sS "$url" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{process.exit(1)}})" 2>/dev/null || true)"
    if [[ "$status" == "ok" || "$status" == "degraded" ]]; then echo "Health: $status"; return 0; fi
    sleep 2
  done
  compose ps
  compose logs app --tail 80 || true
  die "Health-Smoke fehlgeschlagen."
}

resolve_prisma_cli() {
  local candidate
  for candidate in \
    "$ROOT/node_modules/prisma/build/index.js" \
    "$ROOT/packages/db/node_modules/prisma/build/index.js"
  do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  candidate="$(find "$ROOT/node_modules" "$ROOT/packages/db/node_modules" \
    -path '*/prisma/build/index.js' -not -path '*/cache/*' 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" && -f "$candidate" ]] && printf '%s\n' "$candidate"
  return 0
}

resolve_tsx_cli() {
  local candidate
  for candidate in \
    "$ROOT/node_modules/tsx/dist/cli.mjs" \
    "$ROOT/apps/web/node_modules/tsx/dist/cli.mjs" \
    "$ROOT/packages/db/node_modules/tsx/dist/cli.mjs"
  do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  candidate="$(find "$ROOT/node_modules" "$ROOT/apps/web/node_modules" "$ROOT/packages/db/node_modules" \
    -path '*/tsx/dist/cli.mjs' -not -path '*/cache/*' 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" && -f "$candidate" ]] && printf '%s\n' "$candidate"
  return 0
}

host_tool_deps_ready() {
  [[ -n "$(resolve_prisma_cli)" && -n "$(resolve_tsx_cli)" ]]
}

ensure_host_tool_deps() {
  host_tool_deps_ready && return 0
  require_cmd pnpm
  info "Host-Tool-Abhaengigkeiten installieren (Prisma/tsx fuer Backup/Provision)"
  # NODE_ENV=production laesst pnpm devDependencies sonst aus. Die Host-Tools
  # laufen zwar auf einem Prod-Server, brauchen aber Prisma CLI + tsx aus den
  # workspace-devDependencies. Runtime bleibt trotzdem containerisiert.
  (cd "$ROOT" && pnpm install --frozen-lockfile --prod=false \
    --filter @taxtronik/web... --filter @taxtronik/web --filter @taxtronik/db)
  host_tool_deps_ready || die "Host-Tool-Abhaengigkeiten fehlen weiterhin (Prisma CLI/tsx). Bitte pnpm-Install-Log pruefen."
}

generate_prisma_client_for_host_tools() {
  require_cmd node
  ensure_host_tool_deps
  local prisma_cli
  prisma_cli="$(resolve_prisma_cli)"
  [[ -n "$prisma_cli" ]] || die "Prisma CLI fehlt nach Host-Tool-Install."
  info "Prisma Client generieren (Host-Tools)"
  (cd "$ROOT/packages/db" && node "$prisma_cli" generate)
}

run_backup() {
  require_cmd pnpm
  info "Backup starten"
  # .prisma/client fuer den Host-tsx-Runner erzeugen. pnpm 11 + Monorepo führt
  # den @prisma/client-Postinstall nicht zuverlässig aus (Schema liegt in
  # packages/db) — sonst "Cannot find module '.prisma/client/default'".
  generate_prisma_client_for_host_tools
  # pg_dump-Escape-Hatch: falls der Host kein postgresql-client hat (Standard
  # bei Docker-Compose-Only-Setup), pg_dump aus dem laufenden Postgres-Container
  # nutzen. Client-Major passt dann garantiert zum Server (kein apt/Papierkram).
  # runner.ts liest PG_DUMP_PATH gezielt aus (siehe Kopfkommentar dort).
  if ! command -v pg_dump >/dev/null 2>&1; then
    export PG_DUMP_PATH="$ROOT/infra/scripts/pg_dump-via-container.sh"
    info "pg_dump fehlt auf dem Host -> nutze pg_dump aus dem Postgres-Container (PG_DUMP_PATH)."
  fi
  ( cd "$ROOT" && pnpm --filter @taxtronik/web backup:run )
}

# ---------------------------------------------------------------------------
# Hilfs-Ablaeufe fuer bootstrap / rollback
# ---------------------------------------------------------------------------
wait_postgres_healthy() {
  info "Warten bis Postgres healthy ist"
  local deadline=$(( $(date +%s) + 120 )) s
  while :; do
    [[ $(date +%s) -ge $deadline ]] && die "Postgres nach 120 s nicht healthy."
    s="$(docker inspect --format '{{.State.Health.Status}}' taxtronik-postgres 2>/dev/null || true)"
    [[ "$s" == "healthy" ]] && { info "Postgres healthy."; return 0; }
    sleep 2
  done
}

sql_literal() {
  local value
  value="$(printf '%s' "$1" | sed "s/'/''/g")"
  printf "'%s'" "$value"
}

sync_postgres_roles_from_env() {
  require_cmd docker
  require_env POSTGRES_PASSWORD TAXTRONIK_APP_PASSWORD N8N_DB_PASSWORD
  local pg_pw app_pw n8n_pw
  pg_pw="$(sql_literal "$POSTGRES_PASSWORD")"
  app_pw="$(sql_literal "$TAXTRONIK_APP_PASSWORD")"
  n8n_pw="$(sql_literal "$N8N_DB_PASSWORD")"

  info "Postgres-Rollenpasswoerter mit .env synchronisieren"
  {
    printf 'ALTER ROLE taxtronik WITH PASSWORD %s;\n' "$pg_pw"
    printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app') THEN EXECUTE format('ALTER ROLE taxtronik_app WITH PASSWORD %%L', %s); END IF; END \$\$;\n" "$app_pw"
    printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN EXECUTE format('ALTER ROLE n8n WITH PASSWORD %%L', %s); END IF; END \$\$;\n" "$n8n_pw"
  } | docker exec -i taxtronik-postgres psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1
}

# prompt LABEL VAR [DEFAULT]: interaktiv erfragen, falls VAR noch ungesetzt und
# stdin ein TTY ist. Nicht-interaktive Aufrufe (CI) uebernehmen Env-Variablen.
prompt() {
  local label="$1" var="$2" def="${3:-}" input
  [[ -n "${!var:-}" ]] && return 0
  [[ -t 0 ]] || return 0
  read -rp "$label [$def]: " input || true
  printf -v "$var" '%s' "${input:-$def}"
}

url_hostname() {
  local url="${1:-}"
  [[ -z "$url" ]] && return 0
  node -e "try { process.stdout.write(new URL(process.argv[1]).hostname) } catch {}" "$url" 2>/dev/null || true
}

validate_cookie_domains_or_die() {
  local staff_dom portal_dom portal_url
  staff_dom="$(get_env STAFF_COOKIE_DOMAIN)"
  portal_dom="$(get_env PORTAL_COOKIE_DOMAIN)"
  portal_url="$(get_env PORTAL_PUBLIC_URL)"

  [[ -z "$staff_dom" && -z "$portal_dom" ]] && return 0
  [[ -n "$staff_dom" && -n "$portal_dom" ]] || \
    die "STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN muessen gemeinsam gesetzt sein (oder beide leer fuer Single-Host)."
  [[ -n "$portal_url" ]] || \
    die "PORTAL_PUBLIC_URL muss gesetzt sein, wenn STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN gesetzt sind."
  [[ "$staff_dom" != "$portal_dom" ]] || \
    die "STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN muessen unterschiedliche Subdomains sein."
  [[ "$staff_dom" != .* && "$portal_dom" != .* ]] || \
    die "STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN duerfen keine Parent-Domain mit fuehrendem Punkt sein."
  [[ "$staff_dom" != *"://"* && "$portal_dom" != *"://"* && "$staff_dom" != *"/"* && "$portal_dom" != *"/"* && "$staff_dom" != *":"* && "$portal_dom" != *":"* ]] || \
    die "STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN sind reine Hostnames, keine URLs, Pfade oder host:port-Werte."
}

configure_surface_domains_interactive() {
  load_env
  local input portal_url staff_dom portal_dom staff_host portal_host
  portal_url="${PORTAL_PUBLIC_URL:-}"

  if [[ -t 0 && -z "$portal_url" ]]; then
    read -rp "Oeffentliche Portal-URL (PORTAL_PUBLIC_URL, leer = Single-Host) []: " input || true
    if [[ -n "$input" ]]; then
      set_env PORTAL_PUBLIC_URL "$input"
      portal_url="$input"
    fi
  fi

  staff_dom="${STAFF_COOKIE_DOMAIN:-}"
  portal_dom="${PORTAL_COOKIE_DOMAIN:-}"
  if [[ -t 0 ]]; then
    staff_host="$(url_hostname "${NEXTAUTH_URL:-}")"
    portal_host="$(url_hostname "$portal_url")"
    if [[ -z "$portal_url" ]]; then
      staff_host=""
      portal_host=""
    fi

    if [[ -z "$staff_dom" ]]; then
      read -rp "Staff-Cookie-Domain (STAFF_COOKIE_DOMAIN, nur Hostname) [$staff_host]: " input || true
      set_env STAFF_COOKIE_DOMAIN "${input:-$staff_host}"
    fi
    if [[ -z "$portal_dom" ]]; then
      read -rp "Portal-Cookie-Domain (PORTAL_COOKIE_DOMAIN, nur Hostname) [$portal_host]: " input || true
      set_env PORTAL_COOKIE_DOMAIN "${input:-$portal_host}"
    fi
  else
    if [[ -z "$staff_dom" || -z "$portal_dom" ]]; then
      warn "STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN nicht vollstaendig gesetzt (Single-Host oder manuell in .env setzen)."
    fi
  fi

  validate_cookie_domains_or_die
  if [[ -t 0 && -z "$(get_env STAFF_COOKIE_DOMAIN)" && -z "$(get_env PORTAL_COOKIE_DOMAIN)" ]]; then
    warn "Single-Host-Deploy gewaehlt: STAFF_COOKIE_DOMAIN/PORTAL_COOKIE_DOMAIN bleiben leer."
  fi
}

# Schreibt Last-Good-Version fuer rollback. previous = alter current-Stand.
save_state() {
  local new prev=""
  new="$(image_tag)"
  if [[ -f "$STATE" ]]; then prev="$(grep -E '^current=' "$STATE" | head -n1 | cut -d= -f2- || true)"; fi
  printf 'previous=%s\ncurrent=%s\n' "${prev:-}" "$new" > "$STATE"
}

# ---------------------------------------------------------------------------
# .env-Vorbereitung (deploy/update/bootstrap). Stellt sicher, dass der Server
# eine vollstaendige PROD-.env hat, OHNE dass der Operator vorher von Hand
# editieren muss: generiert fehlende Secrets, fragt interaktiv die oeffentliche
# URL ab und backt die generierten DB-Passwoerter in die DATABASE-URLs.
# ---------------------------------------------------------------------------

# Generierte DB-Passwoerter in DATABASE_URL / DATABASE_APP_URL einsetzen, aber
# NUR wenn die URL noch den Platzhalter enthaelt (sonst: eine vom Operator
# bewusst gesetzte URL, z. B. externe DB, wird bewahrt). Host-seitige Tools
# (provision, backup:run) lesen die URL direkt aus .env; Container-ENV wird von
# docker-compose.app.yml ohnehin ueberschrieben.
bake_db_urls_into_env() {
  local pg_pw app_pw cur_db cur_app
  pg_pw="$(get_env POSTGRES_PASSWORD)"; app_pw="$(get_env TAXTRONIK_APP_PASSWORD)"
  cur_db="$(get_env DATABASE_URL)";     cur_app="$(get_env DATABASE_APP_URL)"
  [[ -n "$pg_pw"  && ( -z "$cur_db"  || "$cur_db"  == *'$'"{POSTGRES_PASSWORD}"* ) ]] && \
    set_env DATABASE_URL     "postgresql://taxtronik:${pg_pw}@localhost:5432/taxtronik?schema=public"
  [[ -n "$app_pw" && ( -z "$cur_app" || "$cur_app" == *'$'"{TAXTRONIK_APP_PASSWORD}"* ) ]] && \
    set_env DATABASE_APP_URL "postgresql://taxtronik_app:${app_pw}@localhost:5432/taxtronik?schema=public"
  return 0
}

# Interaktive .env-Vorbereitung fuer deploy/update/bootstrap.
prepare_env_interactive() {
  if [[ ! -f "$ENVFILE" ]]; then
    info ".env fehlt — aus Vorlage anlegen"
    [[ -f "$ROOT/.env.example" ]] || die ".env.example fehlt."
    cp "$ROOT/.env.example" "$ENVFILE"
  fi
  # Prod-Default (NODE_ENV, TAXTRONIK_VERSION) + fehlende Secrets generieren.
  doctor --fix >/dev/null || true
  bake_db_urls_into_env

  # Einzige Angabe, die wir nicht raten duerfen: die oeffentliche Staff-URL.
  # Nur nachfragen, falls leer/localhost UND stdin ein TTY ist (CI vorher setzen).
  load_env
  if [[ -z "${NEXTAUTH_URL:-}" || "$NEXTAUTH_URL" == *localhost* || "$NEXTAUTH_URL" == *127.0.0.1* ]]; then
    local def="${NEXTAUTH_URL:-https://$(hostname 2>/dev/null || echo localhost)}"
    if [[ -t 0 ]]; then
      local input=""
      read -rp "Oeffentliche Staff-URL (NEXTAUTH_URL) [$def]: " input || true
      set_env NEXTAUTH_URL "${input:-$def}"
    else
      warn "NEXTAUTH_URL ist leer/localhost (kein TTY) — bitte spaeter in .env setzen."
    fi
  fi

  # Risk-Layer-Engine (optional, §4): URL + Bearer-Token. Beide oder keines,
  # sonst wirft die ENV-Validierung beim Backup-Schritt. Token min 32 Zeichen.
  # prompt() fragt nur bei TTY und nur, wenn der Wert noch ungesetzt ist.
  configure_surface_domains_interactive

  prompt "Risk-Layer-URL (leer = Risk-Layer inaktiv)" RISK_LAYER_URL ""
  if [[ -n "${RISK_LAYER_URL:-}" ]]; then
    prompt "Risk-Layer Bearer-Token (min 32 Zeichen)" RISK_LAYER_TOKEN ""
    if [[ ${#RISK_LAYER_TOKEN} -lt 32 ]]; then
      warn "RISK_LAYER_TOKEN zu kurz (< 32) — Risk-Layer bleibt inaktiv."
      RISK_LAYER_URL=""; RISK_LAYER_TOKEN=""
    fi
  else
    # URL leer -> Token darf nicht allein stehen (sonst Cross-Field-Fehler).
    RISK_LAYER_TOKEN=""
  fi
  if [[ -n "${RISK_LAYER_URL:-}" && -n "${RISK_LAYER_TOKEN:-}" ]]; then
    set_env RISK_LAYER_URL "$RISK_LAYER_URL"
    set_env RISK_LAYER_TOKEN "$RISK_LAYER_TOKEN"
  else
    set_env RISK_LAYER_URL ""
    set_env RISK_LAYER_TOKEN ""
  fi

  # Schluss-Check (read-only). Bleiben blockierende Fehler, Klartext + Abbruch.
  if ! doctor >/dev/null; then
    doctor
    die ".env noch unvollstaendig — siehe doctor-Ausgabe oben (Tipp: ./taxtronik doctor --fix)."
  fi
  info ".env bereit (Prod)."
}

# Erstinstall-Erkennung: falls die DB noch KEINE Mitarbeiter enthaelt, Tenant +
# Admin anlegen (provision.ts). Auf einer bestehenden Installation ein No-op.
ensure_provisioned_interactive() {
  local count
  count="$(compose --infra exec -T postgres psql -U taxtronik -d taxtronik -tAc \
    'SELECT count(*) FROM staff_user' 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]]; then
    return 0
  fi
  info "Keine Mitarbeiter in der DB — Erstinstall: Tenant + Admin anlegen."
  prompt "Kanzlei-Name (TENANT_NAME)" TENANT_NAME "Kanzlei"
  prompt "Admin-E-Mail (ADMIN_EMAIL)" ADMIN_EMAIL "admin@$(hostname 2>/dev/null || echo localhost)"
  if [[ -z "${TENANT_NAME:-}" || -z "${ADMIN_EMAIL:-}" ]]; then
    warn "Provisionierung uebersprungen (TENANT_NAME/ADMIN_EMAIL leer). Spaeter: TENANT_NAME=.. ADMIN_EMAIL=.. pnpm --filter @taxtronik/db provision"
    return 0
  fi
  generate_prisma_client_for_host_tools
  ( cd "$ROOT" && TENANT_NAME="$TENANT_NAME" ADMIN_EMAIL="$ADMIN_EMAIL" \
      pnpm --filter @taxtronik/db provision ) \
    || warn "Provisionierung fehlgeschlagen — siehe Ausgabe."
}

# Gemeinsame Deploy-Sequenz (deploy + bootstrap). Enthaelt die Erstinstall-
# Erkennung, sodass deploy eine frische Installation komplett abdeckt.
_deploy_core() {
  load_env; preflight_common; assert_production_env; require_release_version
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  backup_before_migrations
  run_migrations
  ensure_provisioned_interactive
  start_apps
  smoke_health
  save_state
}

# ---------------------------------------------------------------------------
# Operator-Kommandos (aufgerufen vom Dispatcher ./taxtronik)
# ---------------------------------------------------------------------------
cmd_deploy() {
  require_cmd docker; require_cmd node; require_cmd curl
  prepare_env_interactive
  _deploy_core
  info "Deploy fertig. Version: $(image_tag)"
}

cmd_update() {
  require_cmd docker; require_cmd node; require_cmd curl; require_cmd git
  info "Code aktualisieren (git ff-only)"
  cd "$ROOT"
  git fetch origin
  git merge --ff-only "${TAXTRONIK_UPDATE_REF:-origin/main}"
  # .env ggfs. aus dem aktualisierten Stand neu vervollstaendigen (Prod-Defaults,
  # fehlende Secrets, NEXTAUTH_URL) — wie bei deploy ohne Hand-Editiererei.
  prepare_env_interactive
  load_env; preflight_common; assert_production_env; require_release_version
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  run_backup
  provide_images
  run_migrations
  start_apps
  smoke_health
  save_state
  info "Update fertig. Version: $(image_tag)"
}

cmd_backup() {
  load_env; preflight_common; assert_production_env
  wait_postgres_healthy
  sync_postgres_roles_from_env
  run_backup
  info "Backup fertig."
}

# Rollback auf einen frueheren Image-Stand. KEINE DB-Migration (Prisma ist
# forward-only) — Schema-Aenderungen bleiben zurueck. Bewusst nur App/Worker,
# nicht n8n/Infra.
cmd_rollback() {
  load_env; preflight_common; assert_production_env
  local target="${1:-}"
  if [[ -z "$target" && -f "$STATE" ]]; then
    target="$(grep -E '^previous=' "$STATE" | head -n1 | cut -d= -f2- || true)"
  fi
  [[ -n "$target" ]] || die "Kein Rollback-Ziel. Nutzung: ./taxtronik rollback <version> (oder .taxtronik.state vorhanden?)."

  local prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" img
  for img in web worker; do
    if ! docker image inspect "$prefix/$img:$target" >/dev/null 2>&1; then
      if images_from_registry; then
        info "Pull $prefix/$img:$target"
        docker pull "$prefix/$img:$target" || die "Pull fehlgeschlagen: $prefix/$img:$target"
      else
        die "Image $prefix/$img:$target nicht lokal vorhanden (Lokalbuild-Modus). Erst './taxtronik deploy' mit TAXTRONIK_VERSION=$target ausfuehren."
      fi
    fi
  done

  set_env TAXTRONIK_VERSION "$target"
  export TAXTRONIK_VERSION="$target"
  warn "Rollback auf $target — KEINE DB-Migration (Prisma forward-only). Schema-Aenderungen bleiben zurueck."
  start_apps
  smoke_health
  info "Rollback fertig. Version: $target"
}

# Prod-Erstinstall in einem Kommando. Funktionell ein Deploy (das seinerseits
# Erstinstall-Erkennung + Provisionierung enthaelt), plus Willkommens-Banner.
cmd_bootstrap() {
  require_cmd docker; require_cmd node; require_cmd git; require_cmd curl
  prepare_env_interactive
  _deploy_core
  info "Bootstrap fertig. Version: $(image_tag)"
  cat <<EOF

=================================================================
  Setup abgeschlossen. Version: $(image_tag)
=================================================================
  Staff-Login : (NEXTAUTH_URL aus .env)/staff/login
  Admin-Zugang: siehe $ROOT/.admin-credentials.txt (falls neu angelegt)
                Nach erstem Login + TOTP-Setup die Datei sicher loeschen.

  Naechste Schritte:
    ./taxtronik doctor     # Env-Check (SMTP/Portal-URL/Lizenz bei Bedarf)
    ./taxtronik logs app   # Logs ansehen
    ./taxtronik update     # Updates einspielen
EOF
}
