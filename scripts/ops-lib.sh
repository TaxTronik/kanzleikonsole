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

# Operator-Konfigurationen enthalten produktive Zugangsdaten. Neue Dateien
# duerfen deshalb auch waehrend ihrer Erzeugung nie ueber Gruppen-/World-Rechte
# verfuegen; explizitere chmod-Aufrufe unten haerten auch bereits vorhandene
# Installationen nach.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env"
BASE="$ROOT/infra/compose/docker-compose.yml"
APP="$ROOT/infra/compose/docker-compose.app.yml"
DEV="$ROOT/infra/compose/docker-compose.dev.yml"
S3_GENERATED="$ROOT/infra/scripts/seaweedfs-s3.generated.json"
STATE="$ROOT/.taxtronik.state"
AWS_CLI_IMAGE_DEFAULT="amazon/aws-cli:latest@sha256:c95ab0642137f55a12b95b6956dd03cefdbd73e760e0e7b870afc9b47f9c8150"
ALPINE_BACKUP_IMAGE_DEFAULT="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

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
  chmod 0600 "$ENVFILE" || die "Dateirechte fuer $ENVFILE konnten nicht auf 0600 gesetzt werden."
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *"="* ]] || continue
    key="${line%%=*}"; value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # Interne Ablauf-Flags duerfen niemals ueber eine persistierte .env einen
    # Sicherheitscheck umgehen. Sie existieren ausschliesslich im laufenden
    # deploy/update/rollback-Prozess.
    [[ "$key" == _TAXTRONIK_INTERNAL_* ]] && continue
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
  # Ersetzungswert für den sed-Befehl unten escapen. Der Befehl nutzt `|` als
  # Delimiter (s|...|...|), daher MUSS `|` mit escaped werden — sonst brechen
  # Werte mit Pipe-Zeichen (z. B. Tokens) das .env-Schreiben (set -e-Abbruch).
  # `&` ist im Replacement special, `/` unschädlich mitzunehmen.
  local esc; esc="$(printf '%s\n' "$value" | sed -e 's/[\/&|]/\\&/g')"
  if grep -qE "^${key}=" "$ENVFILE"; then
    if sed --version >/dev/null 2>&1; then
      sed -i -E "s|^${key}=.*$|${key}=${esc}|" "$ENVFILE"
    else
      sed -i '' -E "s|^${key}=.*$|${key}=${esc}|" "$ENVFILE"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENVFILE"
  fi
  chmod 0600 "$ENVFILE" || die "Dateirechte fuer $ENVFILE konnten nicht auf 0600 gesetzt werden."
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
# SeaweedFS rendert seine S3-Config seit dem Runtime-Secret-Hardening erst im
# Container nach /run (Owner UID 1000, 0400). Host-seitig darf keine lesbare
# Secret-Kopie uebrig bleiben. Der historische Funktionsname bleibt, weil alle
# Compose-Pfade ihn zentral aufrufen.
render_s3_config() {
  local ak sk
  ak="$(get_env S3_ACCESS_KEY)"; sk="$(get_env S3_SECRET_KEY)"
  [[ -n "$ak" && -n "$sk" ]] || die "S3_ACCESS_KEY/S3_SECRET_KEY nicht in .env."
  [[ "$ak$sk" =~ ^[A-Za-z0-9._-]+$ ]] || \
    die "S3_ACCESS_KEY/S3_SECRET_KEY duerfen nur A-Z, a-z, 0-9, Punkt, Unterstrich und Bindestrich enthalten."
  if [[ -d "$S3_GENERATED" ]]; then rmdir "$S3_GENERATED" 2>/dev/null || true; fi
  [[ ! -f "$S3_GENERATED" ]] || rm -f -- "$S3_GENERATED"
}

# compose [--infra] <docker-compose-subcommand> ...
#   --infra: nur Basis-Services (Postgres/Redis/SeaweedFS/ClamAV), ohne app/worker/n8n
ensure_compose_image_pinning() {
  local prefix version web_suffix worker_suffix commit
  prefix="${TAXTRONIK_IMAGE_PREFIX:-$(get_env TAXTRONIK_IMAGE_PREFIX)}"
  [[ -z "$prefix" ]] && prefix="taxtronik"
  [[ "$prefix" == */* ]] || return 0
  version="${TAXTRONIK_VERSION:-$(get_env TAXTRONIK_VERSION)}"
  web_suffix="${TAXTRONIK_WEB_DIGEST_SUFFIX:-$(get_env TAXTRONIK_WEB_DIGEST_SUFFIX)}"
  worker_suffix="${TAXTRONIK_WORKER_DIGEST_SUFFIX:-$(get_env TAXTRONIK_WORKER_DIGEST_SUFFIX)}"
  commit="${TAXTRONIK_RELEASE_COMMIT:-$(get_env TAXTRONIK_RELEASE_COMMIT)}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Registry-Compose verweigert: TAXTRONIK_VERSION muss X.Y.Z sein."
  [[ "$web_suffix" =~ ^@sha256:[0-9a-f]{64}$ ]] || \
    die "Registry-Compose verweigert: TAXTRONIK_WEB_DIGEST_SUFFIX fehlt/ist ungueltig. Erst signierten Release-Vertrag via deploy/update aufloesen."
  [[ "$worker_suffix" =~ ^@sha256:[0-9a-f]{64}$ ]] || \
    die "Registry-Compose verweigert: TAXTRONIK_WORKER_DIGEST_SUFFIX fehlt/ist ungueltig. Erst signierten Release-Vertrag via deploy/update aufloesen."
  [[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Registry-Compose verweigert: TAXTRONIK_RELEASE_COMMIT fehlt/ist ungueltig."
  if [[ "${_TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED:-0}" != "1" ]]; then
    [[ -f "$STATE" ]] || die "Registry-Compose verweigert: $STATE mit verifiziertem Last-Good-Vertrag fehlt. Erst deploy/update ausfuehren."
    [[ "$version" == "$(state_value current)" && \
       "$web_suffix" == "$(state_value current_web_digest_suffix)" && \
       "$worker_suffix" == "$(state_value current_worker_digest_suffix)" && \
       "$commit" == "$(state_value current_commit)" ]] || \
      die "Registry-Compose verweigert: .env/Prozessvertrag weicht vom verifizierten Last-Good-State ab. deploy/update/rollback verwenden."
  fi
}

compose() {
  render_s3_config
  if [[ "${1:-}" == "--infra" ]]; then
    shift
    docker compose -f "$BASE" --env-file "$ENVFILE" "$@"
  else
    ensure_compose_image_pinning
    if [[ "${1:-}" == "up" ]]; then
      reconcile_n8n_encryption_key_from_volume
    fi
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

semver_ge() {
  local left="$1" right="$2" l1 l2 l3 r1 r2 r3
  IFS=. read -r l1 l2 l3 <<<"$left"
  IFS=. read -r r1 r2 r3 <<<"$right"
  (( 10#$l1 > 10#$r1 )) && return 0
  (( 10#$l1 < 10#$r1 )) && return 1
  (( 10#$l2 > 10#$r2 )) && return 0
  (( 10#$l2 < 10#$r2 )) && return 1
  (( 10#$l3 >= 10#$r3 ))
}

current_installed_version() {
  local value=""
  if [[ -f "$STATE" ]]; then
    value="$(grep -E '^current=' "$STATE" | head -n1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
}

resolve_release_contract() {
  images_from_registry || return 0
  [[ "${TAXTRONIK_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Registry-Releases brauchen TAXTRONIK_VERSION=X.Y.Z."
  [[ -n "${UPDATE_PUBLIC_KEY:-}" ]] || die "UPDATE_PUBLIC_KEY fehlt; Registry-Release wird ohne Signatur nicht aufgeloest."

  local tmp manifest signature manifest_file="${UPDATE_MANIFEST_FILE:-}" signature_file="${UPDATE_MANIFEST_SIGNATURE_FILE:-}"
  tmp="$(mktemp -d)" || die "Temp-Verzeichnis fuer Release-Manifest konnte nicht erstellt werden."
  manifest="$tmp/manifest.json"
  signature="$tmp/manifest.json.sig"

  if [[ -n "$manifest_file" ]]; then
    [[ -f "$manifest_file" ]] || die "UPDATE_MANIFEST_FILE nicht gefunden: $manifest_file"
    [[ -z "$signature_file" ]] && signature_file="${manifest_file}.sig"
    [[ -f "$signature_file" ]] || die "UPDATE_MANIFEST_SIGNATURE_FILE nicht gefunden: $signature_file"
    cp "$manifest_file" "$manifest"
    cp "$signature_file" "$signature"
  else
    [[ "${UPDATE_MANIFEST_URL:-}" == https://* ]] || \
      die "UPDATE_MANIFEST_URL muss HTTPS verwenden (oder UPDATE_MANIFEST_FILE fuer Air-Gap setzen)."
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 30 "$UPDATE_MANIFEST_URL" | head -c 1048577 > "$manifest" || \
      die "Signiertes Update-Manifest konnte nicht geladen werden."
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 30 "${UPDATE_MANIFEST_URL}.sig" | head -c 4097 > "$signature" || \
      die "Detached Update-Manifest-Signatur konnte nicht geladen werden."
  fi
  [[ "$(wc -c < "$manifest")" -le 1048576 ]] || die "Update-Manifest ist groesser als 1 MiB."
  [[ "$(wc -c < "$signature")" -le 4096 ]] || die "Update-Manifest-Signatur ist groesser als 4 KiB."

  local contract key value
  contract="$(UPDATE_PUBLIC_KEY="$UPDATE_PUBLIC_KEY" node "$ROOT/scripts/release/verify-update-manifest.mjs" \
    --manifest "$manifest" --signature "$signature" --version "$TAXTRONIK_VERSION" --format env)" || \
    die "Update-Manifest/Signatur/Release-Vertrag ungueltig."
  rm -f "$manifest" "$signature"
  rmdir "$tmp" 2>/dev/null || true

  UPDATE_VERSION=""; UPDATE_COMMIT_SHA=""; UPDATE_MIGRATIONS_REQUIRED=""
  UPDATE_MIN_PREVIOUS_VERSION=""; UPDATE_WEB_IMAGE=""; UPDATE_WEB_DIGEST=""
  UPDATE_WORKER_IMAGE=""; UPDATE_WORKER_DIGEST=""
  while IFS='=' read -r key value; do
    case "$key" in
      UPDATE_VERSION|UPDATE_COMMIT_SHA|UPDATE_MIGRATIONS_REQUIRED|UPDATE_MIN_PREVIOUS_VERSION|UPDATE_WEB_IMAGE|UPDATE_WEB_DIGEST|UPDATE_WORKER_IMAGE|UPDATE_WORKER_DIGEST)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  done <<<"$contract"

  local expected_prefix="${TAXTRONIK_IMAGE_PREFIX%/}" installed
  [[ "$UPDATE_VERSION" == "$TAXTRONIK_VERSION" ]] || die "Manifest-Version stimmt nicht mit TAXTRONIK_VERSION ueberein."
  [[ "$UPDATE_WEB_IMAGE" == "$expected_prefix/web:$TAXTRONIK_VERSION" ]] || \
    die "Manifest-Web-Image gehoert nicht zum konfigurierten TAXTRONIK_IMAGE_PREFIX."
  [[ "$UPDATE_WORKER_IMAGE" == "$expected_prefix/worker:$TAXTRONIK_VERSION" ]] || \
    die "Manifest-Worker-Image gehoert nicht zum konfigurierten TAXTRONIK_IMAGE_PREFIX."
  [[ "$UPDATE_COMMIT_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || die "Manifest-Commit ungueltig."
  [[ "$UPDATE_WEB_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Manifest-Web-Digest ungueltig."
  [[ "$UPDATE_WORKER_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Manifest-Worker-Digest ungueltig."

  installed="$(current_installed_version)"
  if [[ -n "$installed" && -n "$UPDATE_MIN_PREVIOUS_VERSION" ]]; then
    [[ "$installed" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Installierte Version in $STATE ist kein SemVer: $installed"
    semver_ge "$installed" "$UPDATE_MIN_PREVIOUS_VERSION" || \
      die "Update $TAXTRONIK_VERSION erfordert mindestens $UPDATE_MIN_PREVIOUS_VERSION (installiert: $installed)."
  elif [[ -z "$installed" && -n "$UPDATE_MIN_PREVIOUS_VERSION" && -n "$(_app_container_id)" ]]; then
    # Ein bestehender Stack ohne State darf den Mindeststand nicht still
    # umgehen. Einmal die aktuell installierte Version via `deploy` gegen ihr
    # Manifest verankern; eine echte Erstinstallation hat noch keine Container.
    die "$STATE fehlt bei bestehender Installation; minPreviousVersion kann nicht sicher geprueft werden. Zuerst aktuellen Release-Vertrag per deploy verankern."
  fi
}

# Staged den verifizierten Vertrag nur fuer den laufenden Prozess. Compose
# bekommt damit exakt die signierten Digests, waehrend .env und STATE bis zum
# bestandenen Health-/Readiness-Gate unveraendert Last-Good bleiben.
stage_release_contract() {
  if images_from_registry; then
    [[ "$UPDATE_WEB_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && \
       "$UPDATE_WORKER_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && \
       "$UPDATE_COMMIT_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
      die "Release-Vertrag kann nicht gestaged werden: Digest/Commit ungueltig."
    export TAXTRONIK_WEB_DIGEST_SUFFIX="@$UPDATE_WEB_DIGEST"
    export TAXTRONIK_WORKER_DIGEST_SUFFIX="@$UPDATE_WORKER_DIGEST"
    export TAXTRONIK_RELEASE_COMMIT="$UPDATE_COMMIT_SHA"
    export TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED="${UPDATE_MIGRATIONS_REQUIRED:-}"
  else
    # Explizit leere Prozesswerte verhindern, dass Compose bei einem Wechsel
    # vom Registry- zum Lokalbuild-Modus alte Digest-Suffixe weiterverwendet.
    export TAXTRONIK_WEB_DIGEST_SUFFIX=""
    export TAXTRONIK_WORKER_DIGEST_SUFFIX=""
    export TAXTRONIK_RELEASE_COMMIT=""
    export TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED=""
  fi
  export _TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED=1
}

# Persistiert ausschliesslich einen bereits erfolgreichen Last-Good-Vertrag.
# save_state wird davor atomar geschrieben; scheitert ein einzelnes .env-Update,
# blockiert ensure_compose_image_pinning jeden spaeteren Mischbetrieb fail-closed.
commit_release_contract() {
  set_env TAXTRONIK_VERSION "${TAXTRONIK_VERSION:-}"
  set_env TAXTRONIK_WEB_DIGEST_SUFFIX "${TAXTRONIK_WEB_DIGEST_SUFFIX:-}"
  set_env TAXTRONIK_WORKER_DIGEST_SUFFIX "${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}"
  set_env TAXTRONIK_RELEASE_COMMIT "${TAXTRONIK_RELEASE_COMMIT:-}"
  set_env TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED "${TAXTRONIK_RELEASE_MIGRATIONS_REQUIRED:-}"
  unset _TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED
}

prepare_release_contract() {
  if images_from_registry; then
    resolve_release_contract
    verify_release_checkout
    stage_release_contract
  else
    stage_release_contract
  fi
}

verify_release_checkout() {
  images_from_registry || return 0
  local checkout
  checkout="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$checkout" == "$UPDATE_COMMIT_SHA" ]] || \
    die "Checkout $checkout entspricht nicht dem signierten Release-Commit $UPDATE_COMMIT_SHA."
  git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet || \
    die "Registry-Deploy verweigert: getrackte lokale Aenderungen im Deployment-Checkout."
}

deployment_git_remote() {
  local branch remote
  branch="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
  remote="$(git -C "$ROOT" config --get "branch.${branch}.remote" 2>/dev/null || true)"
  if [[ -z "$remote" || "$remote" == "." ]]; then
    if git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then remote=origin
    elif git -C "$ROOT" remote get-url forgejo >/dev/null 2>&1; then remote=forgejo
    else die "Kein Git-Remote fuer Updates konfiguriert."; fi
  fi
  printf '%s' "${TAXTRONIK_GIT_REMOTE:-$remote}"
}

fetch_verified_release_tag() {
  local version="$1" expected_commit="$2" remote target_ref
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Release-Tag braucht SemVer X.Y.Z: $version"
  [[ "$expected_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || die "Release-Commit ungueltig: $expected_commit"
  remote="$(deployment_git_remote)"
  target_ref="refs/tags/v${version}"
  git -C "$ROOT" fetch --no-tags "$remote" "$target_ref:$target_ref"
  [[ "$(git -C "$ROOT" cat-file -t "$target_ref" 2>/dev/null || true)" == "tag" ]] || \
    die "Release-Tag v${version} fehlt oder ist nicht annotiert."
  [[ "$(git -C "$ROOT" rev-parse "${target_ref}^{commit}")" == "$expected_commit" ]] || \
    die "Release-Tag v${version} und signierter Release-Vertrag zeigen auf verschiedene Commits."
}

require_clean_release_checkout() {
  git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet || \
    die "Release-Checkout enthaelt getrackte lokale Aenderungen; sicherer Checkout-Wechsel verweigert."
}

pull_release_images_direct() {
  local prefix="${TAXTRONIK_IMAGE_PREFIX%/}" version
  version="$(image_tag)"
  info "Digest-gepinnte Rollback-Images direkt ziehen: ${prefix}/{web,worker}:$version"
  docker pull "${prefix}/web:${version}${TAXTRONIK_WEB_DIGEST_SUFFIX}"
  docker pull "${prefix}/worker:${version}${TAXTRONIK_WORKER_DIGEST_SUFFIX}"
  verify_release_image_labels
}

prune_build_cache() {
  local mode until
  mode="${TAXTRONIK_BUILD_CACHE_PRUNE:-auto}"
  until="${TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL:-168h}"

  [[ "$mode" == "off" ]] && {
    info "Docker-Build-Cache-Prune uebersprungen (TAXTRONIK_BUILD_CACHE_PRUNE=off)."
    return 0
  }

  info "Docker-Build-Cache aufraeumen (unused > $until)"
  docker builder prune --force --filter "until=$until" >/dev/null || \
    warn "Docker-Build-Cache konnte nicht bereinigt werden (Deploy laeuft weiter)."
}

require_release_version() {
  [[ -n "${TAXTRONIK_VERSION:-}" ]] || \
    die "TAXTRONIK_VERSION fehlt in .env. Auf ein Release pinnen (z. B. TAXTRONIK_VERSION=1.4.0) — oder './taxtronik bootstrap' bzw. 'doctor --fix' fuer ein Erstdeploy."
  if images_from_registry; then
    [[ "$TAXTRONIK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
      die "Registry-Modus akzeptiert nur striktes SemVer X.Y.Z (aktuell: $TAXTRONIK_VERSION)."
  fi
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
    S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY N8N_HMAC_SECRET N8N_ENCRYPTION_KEY N8N_DB_PASSWORD
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

smtp_points_to_dev_mailhog() {
  local host="${1:-}" port="${2:-}" host_lc
  host_lc="${host,,}"
  [[ "$host_lc" == "mailhog" || ( ( "$host_lc" == "localhost" || "$host" == "127.0.0.1" ) && "$port" == "1025" ) ]]
}

_n8n_container_id() {
  docker ps -aq --filter 'name=^/taxtronik-n8n$' 2>/dev/null | head -n1 || true
}

_app_container_id() {
  docker ps -aq --filter 'name=^/taxtronik-app$' 2>/dev/null | head -n1 || true
}

_n8n_home_volume() {
  local cid="$1"
  [[ -n "$cid" ]] || return 0
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/node/.n8n"}}{{.Name}}{{end}}{{end}}' "$cid" 2>/dev/null || true
}

_compose_project_name() {
  printf '%s' "${COMPOSE_PROJECT_NAME:-$(basename "$(dirname "$BASE")")}"
}

_n8n_data_volume() {
  local cid="${1:-}" project volume candidate
  [[ -z "$cid" ]] && cid="$(_n8n_container_id)"

  volume="$(_n8n_home_volume "$cid")"
  if [[ -n "$volume" ]]; then
    printf '%s\n' "$volume"
    return 0
  fi

  project="$(_compose_project_name)"
  volume="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.volume=n8n_data' 2>/dev/null | head -n1 || true)"
  if [[ -n "$volume" ]]; then
    printf '%s\n' "$volume"
    return 0
  fi

  candidate="${project}_n8n_data"
  if docker volume inspect "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
  fi
}

_extract_n8n_encryption_key_from_file() {
  local file="$1"
  [[ -r "$file" ]] || return 0
  sed -n 's/.*"encryptionKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n1 || true
}

_n8n_config_encryption_key() {
  local cid="$1" volume="$2" image running mountpoint
  if [[ -n "$cid" ]]; then
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)"
  fi
  if [[ -n "${cid:-}" && "$running" == "true" ]]; then
    docker exec "$cid" node -p \
      "const fs=require('fs'); const p='/home/node/.n8n/config'; fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p,'utf8')).encryptionKey || '') : ''" \
      2>/dev/null || true
    return 0
  fi

  [[ -n "$volume" ]] || return 0
  mountpoint="$(docker volume inspect -f '{{.Mountpoint}}' "$volume" 2>/dev/null || true)"
  if [[ -n "$mountpoint" && -f "$mountpoint/config" ]]; then
    _extract_n8n_encryption_key_from_file "$mountpoint/config"
    return 0
  fi

  if [[ -n "${cid:-}" ]]; then
    image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  fi
  image="${image:-alpine:3.20}"
  docker run --rm --entrypoint node -v "$volume:/data:ro" "$image" -p \
    "const fs=require('fs'); const p='/data/config'; fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p,'utf8')).encryptionKey || '') : ''" \
    2>/dev/null || \
  docker run --rm -v "$volume:/data:ro" alpine:3.20 sh -c \
    "test -f /data/config && sed -n 's/.*\"encryptionKey\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' /data/config | head -n1" \
    2>/dev/null || true
}

reconcile_n8n_encryption_key_from_volume() {
  command -v docker >/dev/null 2>&1 || return 0
  [[ -f "$ENVFILE" ]] || return 0

  local cid volume volume_key env_key
  cid="$(_n8n_container_id)"
  volume="$(_n8n_data_volume "$cid")"
  [[ -n "$volume" ]] || return 0

  volume_key="$(_n8n_config_encryption_key "$cid" "$volume" | tr -d '\r\n')"
  [[ -n "$volume_key" ]] || return 0

  env_key="$(get_env N8N_ENCRYPTION_KEY)"
  if [[ -z "$env_key" ]]; then
    info "N8N_ENCRYPTION_KEY aus vorhandenem n8n-Volume uebernommen (${volume})."
    set_env N8N_ENCRYPTION_KEY "$volume_key"
    export N8N_ENCRYPTION_KEY="$volume_key"
  elif [[ "$env_key" != "$volume_key" ]]; then
    warn "N8N_ENCRYPTION_KEY in .env passt nicht zum vorhandenen n8n-Volume (${volume}); .env wird auf den Volume-Key korrigiert."
    set_env N8N_ENCRYPTION_KEY "$volume_key"
    export N8N_ENCRYPTION_KEY="$volume_key"
  fi
}

_doctor_n8n_volume_key() {
  command -v docker >/dev/null 2>&1 || return 0
  [[ -n "${N8N_ENCRYPTION_KEY:-}" ]] || return 0

  local cid volume volume_key
  cid="$(_n8n_container_id)"
  volume="$(_n8n_data_volume "$cid")"
  [[ -n "$volume" ]] || return 0
  volume_key="$(_n8n_config_encryption_key "$cid" "$volume" | tr -d '\r\n')"

  if [[ -z "$volume_key" ]]; then
    _dr_row "WARN" "N8N_VOLUME_KEY" "nicht lesbar/noch nicht initialisiert"
    _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ "$volume_key" != "$N8N_ENCRYPTION_KEY" ]]; then
    _dr_row "FEHLT" "N8N_VOLUME_KEY" "passt nicht zu .env (Volume: ${volume:-unbekannt})"
    echo "           Bestehende n8n-Daten behalten: N8N_ENCRYPTION_KEY in .env auf den Volume-Key setzen."
    echo "           Frisches n8n akzeptieren: ./taxtronik down && docker volume rm ${volume:-<n8n-volume>} && ./taxtronik up -d"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "N8N_VOLUME_KEY" "passt zu .env"
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
    [[ -z "$(get_env TIMESTAMP_AUTHORITY_URL)" ]] && { set_env TIMESTAMP_AUTHORITY_URL "http://timestamp.globalsign.com/tsa/r6advanced1"; info "TIMESTAMP_AUTHORITY_URL=GlobalSign gesetzt."; }
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
  _doctor_n8n_volume_key
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

  if [[ -z "${SMTP_HOST:-}" ]]; then
    _dr_row "FEHLT" "SMTP_HOST" "Prod braucht ein echtes SMTP-Relay (Mailhog nur Dev)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif smtp_points_to_dev_mailhog "${SMTP_HOST:-}" "${SMTP_PORT:-}"; then
    _dr_row "FEHLT" "SMTP_HOST" "Dev-Mailhog-Default (${SMTP_HOST}:${SMTP_PORT:-}) darf nicht in Prod deployen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "SMTP_HOST" "$SMTP_HOST"
  fi
  if [[ -z "${SMTP_PORT:-}" ]]; then
    _dr_row "FEHLT" "SMTP_PORT" "leer"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "SMTP_PORT" "$SMTP_PORT"
  fi
  if [[ -z "${SMTP_FROM:-}" ]]; then
    _dr_row "FEHLT" "SMTP_FROM" "leer"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "SMTP_FROM" "$SMTP_FROM"
  fi
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
  prune_build_cache
}

pull_images() {
  info "Digest-gepinnte Images aus Registry ziehen: ${TAXTRONIK_IMAGE_PREFIX}/{web,worker}:$(image_tag)"
  compose pull app worker
  verify_release_image_labels
}

verify_release_image_labels() {
  images_from_registry || return 0
  local role suffix ref revision version
  for role in web worker; do
    if [[ "$role" == "web" ]]; then suffix="$TAXTRONIK_WEB_DIGEST_SUFFIX"
    else suffix="$TAXTRONIK_WORKER_DIGEST_SUFFIX"; fi
    ref="${TAXTRONIK_IMAGE_PREFIX%/}/$role:$(image_tag)$suffix"
    revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref" 2>/dev/null || true)"
    version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ref" 2>/dev/null || true)"
    [[ "$revision" == "$TAXTRONIK_RELEASE_COMMIT" ]] || \
      die "$role-Image-Label revision=$revision stimmt nicht mit signiertem Commit $TAXTRONIK_RELEASE_COMMIT ueberein."
    [[ "$version" == "$(image_tag)" ]] || \
      die "$role-Image-Label version=$version stimmt nicht mit Release $(image_tag) ueberein."
  done
  info "OCI-Labels fuer Web + Worker stimmen mit signiertem Release-Vertrag ueberein."
}

# Pull-before-Stop: Images beschaffen, waehrend der alte Stand noch laeuft —
# Downtime beim Update reduziert sich auf den reinen Container-Neustart.
provide_images() { if images_from_registry; then pull_images; else build_images; fi; }

resolve_backup_host_dir() {
  local dir="${BACKUP_HOST_DIR:-../../backups}"
  if [[ "$dir" == /* ]]; then
    printf '%s\n' "$dir"
  else
    # Compose loest relative Bind-Mounts relativ zum Compose-File auf.
    (cd "$ROOT/infra/compose" && mkdir -p "$dir" && cd "$dir" && pwd -P)
  fi
}

prepare_backup_host_dir() {
  local dir
  dir="$(resolve_backup_host_dir)"
  info "Backup-Verzeichnis vorbereiten: $dir"
  mkdir -p "$dir" || die "Backup-Verzeichnis konnte nicht angelegt werden: $dir"
  chmod 0770 "$dir" 2>/dev/null || warn "chmod 0770 fuer $dir fehlgeschlagen."
  # Linux-Prod: node-User im Container hat UID/GID 1000. Wenn der Operator kein
  # chown darf, korrigiert backup-dir-init den Bind-Mount im Container.
  chown 1000:1000 "$dir" 2>/dev/null || true
}

run_backup_dir_init() {
  prepare_backup_host_dir
  info "Backup-Bind-Mount fuer App-Container berechtigen"
  docker rm -f taxtronik-backup-dir-init >/dev/null 2>&1 || true
  compose run --rm --no-deps backup-dir-init >/dev/null || \
    warn "backup-dir-init konnte den Bind-Mount nicht korrigieren. Pruefe BACKUP_HOST_DIR-Rechte, falls Browser-Backups EACCES liefern."
}

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
start_apps()  {
  info "App, Worker und n8n starten/neu erzeugen"
  run_backup_dir_init
  compose up -d --force-recreate --no-deps app worker n8n
}

smoke_health() {
  local url status
  url="http://127.0.0.1:$(app_port)/api/health"
  info "Health-Smoke: $url"
  for _ in {1..30}; do
    # KEIN curl -f: wir lesen den JSON-Status selbst. `degraded` bedeutet, dass
    # mindestens eine produktive Abhaengigkeit ausgefallen ist, und darf einen
    # Deploy/Update deshalb NICHT als erfolgreich markieren.
    status="$(curl -sS "$url" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{process.exit(1)}})" 2>/dev/null || true)"
    if [[ "$status" == "ok" ]]; then echo "Health: ok"; return 0; fi
    sleep 2
  done
  compose ps
  compose logs app --tail 80 || true
  warn "Health-Smoke fehlgeschlagen (nur status=ok gilt als bereit)."
  return 1
}

# Prod-Konfigurations-Gate NACH dem Deploy. smoke_health prueft nur die
# ERREICHBARKEIT (der /api/health-Endpoint aus dem Container); dieser Check geht
# tiefer und faengt prod-spezifische KONFIGURATIONS-Fehler (S3-Buckets fehlen /
# kein Object-Lock, ClamAV-StreamMaxLength < Upload-Cap, keine ClamAV-Signaturen,
# Storage-Schreib/Lese-Roundtrip kaputt) — genau die Klasse, die sonst erst beim
# Kunden auffaellt (z. B. der GwG-Upload). Laeuft als Host-Tool gegen die
# VEROEFFENTLICHTEN Ports (docker port), unabhaengig von den internen
# Container-Endpunkten. Mit Retry: frisches ClamAV laedt die Signaturen (EICAR)
# ggf. erst nach dem TCP-Up per freshclam.
deploy_readiness() {
  local s3_hp clam_hp s3_endpoint clam_host clam_port
  s3_hp="$(docker port taxtronik-seaweedfs 8333 2>/dev/null | head -n1 || true)"
  clam_hp="$(docker port taxtronik-clamav 3310 2>/dev/null | head -n1 || true)"
  if [[ -z "$s3_hp" || -z "$clam_hp" ]]; then
    warn "Deploy-Readiness fehlgeschlagen: SeaweedFS/ClamAV-Hostports nicht ermittelbar."
    return 1
  fi
  s3_endpoint="http://${s3_hp/0.0.0.0/127.0.0.1}"
  clam_host="${clam_hp%%:*}"; clam_host="${clam_host/0.0.0.0/127.0.0.1}"
  clam_port="${clam_hp##*:}"

  info "Deploy-Readiness: S3=$s3_endpoint ClamAV=$clam_host:$clam_port"
  local attempt
  for attempt in 1 2 3 4; do
    if ( cd "$ROOT" && \
         S3_ENDPOINT="$s3_endpoint" CLAMAV_HOST="$clam_host" CLAMAV_PORT="$clam_port" \
         pnpm --filter @taxtronik/storage verify:deploy ); then
      info "Deploy-Readiness OK."
      return 0
    fi
    if [[ $attempt -lt 4 ]]; then
      warn "Deploy-Readiness noch nicht bereit (Versuch $attempt/4) — 20 s warten (ClamAV-Signaturen?)."
      sleep 20
    fi
  done
  warn "Deploy-Readiness fehlgeschlagen — Prod-Konfiguration nicht bereit (S3-Buckets/Object-Lock/ClamAV/Roundtrip)."
  return 1
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
  generate_prisma_client_for_host_tools || return $?
  # pg_dump-Escape-Hatch: falls der Host kein postgresql-client hat (Standard
  # bei Docker-Compose-Only-Setup), pg_dump aus dem laufenden Postgres-Container
  # nutzen. Client-Major passt dann garantiert zum Server (kein apt/Papierkram).
  # runner.ts liest PG_DUMP_PATH gezielt aus (siehe Kopfkommentar dort).
  if ! command -v pg_dump >/dev/null 2>&1; then
    export PG_DUMP_PATH="$ROOT/infra/scripts/pg_dump-via-container.sh"
    info "pg_dump fehlt auf dem Host -> nutze pg_dump aus dem Postgres-Container (PG_DUMP_PATH)."
  fi
  ensure_s3_ready_for_backup || return $?
  ( cd "$ROOT" && pnpm --filter @taxtronik/web backup:run )
}

# P2-21: n8n-Datenbank sichern (Credentials/Ausführungshistorie). Die App-DB
# (taxtronik) deckt run_backup ab; die separate `n8n`-Postgres-DB fehlte im
# Backup. Dump landet als Custom-Format im lokalen Backup-Verzeichnis.
# Wiederherstellung manuell: pg_restore -h 127.0.0.1 -U n8n -d n8n <dump>
# (plus n8n_data-Volume; N8N_ENCRYPTION_KEY muss zum Dump passen).
run_backup_n8n() {
  local dest="${1:-${BACKUP_LOCAL_DIR:-$ROOT/backups}}"
  mkdir -p "$dest"
  local out="$dest/n8n-db-$(date -u +'%Y%m%dT%H%M%SZ').dump"
  info "n8n-Datenbank sichern -> $out"
  # Secret nur im Prozess-Env (nicht in der Container-argv, vgl. P3-2).
  PGPASSWORD="${N8N_DB_PASSWORD:-n8n}" docker exec -i -e PGPASSWORD taxtronik-postgres \
    pg_dump -h 127.0.0.1 -U n8n -d n8n -Fc > "$out"
  info "n8n-Datenbank gesichert ($(du -h "$out" 2>/dev/null | cut -f1))."
}

object_store_backup_buckets() {
  printf '%s\n' ${BACKUP_OBJECT_BUCKETS:-${S3_BUCKET_GOBD:-gobd} ${S3_BUCKET_GWG:-gwg} ${S3_BUCKET_GENERAL:-general} ${S3_BUCKET_STAFF_PRIVATE:-staff-private}}
}

run_backup_files() {
  require_cmd docker
  local host_dir stamp dest bucket endpoint buckets_file
  prepare_backup_host_dir
  host_dir="$(resolve_backup_host_dir)"
  stamp="$(date -u +'%Y%m%d-%H%M%S')"
  dest="${1:-$host_dir/object-store/$stamp}"
  mkdir -p "$dest" || die "Object-Store-Backup-Ziel konnte nicht angelegt werden: $dest"
  chmod 0700 "$dest" 2>/dev/null || true

  endpoint="${BACKUP_OBJECT_ENDPOINT:-http://seaweedfs:8333}"
  buckets_file="$dest/buckets.txt"
  : > "$buckets_file"

  info "Kanzleidateien aus SeaweedFS exportieren: $dest"
  info "Hinweis: Dies ist eine Byte-Kopie der Buckets. Fuer Object-Lock-/Versioning-Metadaten zusaetzlich SeaweedFS-Replikation oder Volume-Snapshots nutzen."

  while IFS= read -r bucket; do
    [[ -z "$bucket" ]] && continue
    printf '%s\n' "$bucket" >> "$buckets_file"
    info "Bucket exportieren: $bucket"
    # P3-2: Secrets NICHT als `-e VAR=wert` (landet in der Container-argv, per
    # `docker inspect`/`ps` lesbar) — stattdessen im Prozess-Env setzen und per
    # `-e VAR` (ohne Wert) durchreichen. Docker liest den Wert dann aus dem Env.
    AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}" \
    docker run --rm \
      --network taxtronik \
      -e AWS_ACCESS_KEY_ID \
      -e AWS_SECRET_ACCESS_KEY \
      -e AWS_DEFAULT_REGION \
      -v "$dest:/backup" \
      "${TAXTRONIK_AWS_CLI_IMAGE:-$AWS_CLI_IMAGE_DEFAULT}" \
      --endpoint-url "$endpoint" s3 sync "s3://$bucket" "/backup/$bucket" --only-show-errors
  done < <(object_store_backup_buckets)

  {
    printf 'created_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'endpoint=%s\n' "$endpoint"
    printf 'buckets='
    paste -sd, "$buckets_file"
  } > "$dest/manifest.txt"
  info "Kanzleidateien-Export fertig: $dest"
}

container_named_volume() {
  local container="$1" destination="$2"
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" \
    "$container" 2>/dev/null || true
}

snapshot_named_volume() {
  local volume="$1" output_dir="$2" archive_name="$3"
  [[ -n "$volume" ]] || { warn "Docker-Volume fuer $archive_name nicht gefunden."; return 1; }
  mkdir -p "$output_dir"
  info "Cold-Snapshot Docker-Volume $volume -> $archive_name"
  docker run --rm \
    -v "$volume:/source:ro" \
    -v "$output_dir:/backup" \
    "${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}" \
    tar -C /source -czf "/backup/$archive_name" .
}

# Konsistenter Cold-Snapshot der nicht-relationalen, zustandsbehafteten Volumes.
# Der kurze Stop ist bewusst: Nur so bleiben SeaweedFS-Versionen/Object-Lock-
# Metadaten und Redis-AOF zusammen mit dem n8n-Volume auf einem definierten
# Zeitpunkt. Die DB-Dumps entstehen separat transaktionskonsistent via pg_dump.
run_cold_volume_snapshots() {
  local dest="$1" seaweed_volume redis_volume n8n_volume snapshot_rc=0 restart_rc=0
  seaweed_volume="$(container_named_volume taxtronik-seaweedfs /data)"
  redis_volume="$(container_named_volume taxtronik-redis /data)"
  n8n_volume="$(container_named_volume taxtronik-n8n /home/node/.n8n)"
  if [[ -z "$seaweed_volume" || -z "$redis_volume" || -z "$n8n_volume" ]]; then
    warn "Full-Backup kann benoetigte Volumes nicht aufloesen (SeaweedFS/Redis/n8n)."
    restart_backup_infra || true
    return 1
  fi

  info "SeaweedFS/Redis fuer konsistenten Volume-Snapshot stoppen (Schreibdienste sind bereits quiesziert)"
  if ! compose --infra stop seaweedfs redis; then
    restart_backup_infra || true
    return 1
  fi

  snapshot_named_volume "$seaweed_volume" "$dest" seaweedfs-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$redis_volume" "$dest" redis-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$n8n_volume" "$dest" n8n-data.tar.gz || snapshot_rc=$?

  restart_backup_infra || restart_rc=$?
  if [[ $restart_rc -ne 0 ]]; then
    warn "Dienste konnten nach dem Cold-Snapshot nicht vollstaendig gestartet werden. Sofort manuell pruefen."
    return 1
  fi
  if [[ $snapshot_rc -ne 0 ]]; then
    warn "Mindestens ein Volume-Snapshot ist fehlgeschlagen; Dienste wurden wieder gestartet."
    return 1
  fi
}

restart_backup_infra() {
  info "SeaweedFS/Redis nach Cold-Snapshot wieder starten"
  compose --infra up -d --wait redis seaweedfs
}

restart_after_full_backup() {
  local rc=0
  info "Infra und Anwendungen nach Full-Backup wieder starten"
  restart_backup_infra || rc=$?
  if [[ $rc -eq 0 ]]; then start_apps || rc=$?; fi
  if [[ $rc -eq 0 ]]; then smoke_health || rc=$?; fi
  return "$rc"
}

_FULL_BACKUP_STAGING=""
_FULL_BACKUP_SERVICES_QUIESCED=0

full_backup_exit_cleanup() {
  local original_rc="${1:-1}"
  trap - EXIT INT TERM
  if [[ "$_FULL_BACKUP_SERVICES_QUIESCED" == "1" ]]; then
    restart_after_full_backup || warn "Notfall-Wiederanlauf nach abgebrochenem Full-Backup fehlgeschlagen."
  fi
  if [[ -n "$_FULL_BACKUP_STAGING" && -d "$_FULL_BACKUP_STAGING" ]]; then
    remove_full_backup_staging "$_FULL_BACKUP_STAGING" || warn "Plaintext-Staging konnte nicht entfernt werden: $_FULL_BACKUP_STAGING"
  fi
  exit "$original_rc"
}

cleanup_abandoned_full_backup_staging() {
  local full_root candidate
  full_root="$(resolve_backup_host_dir)/full"
  [[ -d "$full_root" ]] || return 0
  while IFS= read -r candidate; do
    [[ "$candidate" == "$full_root"/*/.staging ]] || die "Unsicheres Staging-Cleanup verweigert: $candidate"
    warn "Verwaistes Plaintext-Staging eines abgebrochenen Full-Backups entfernen: $candidate"
    rm -rf -- "$candidate"
  done < <(find "$full_root" -mindepth 2 -maxdepth 2 -type d -name .staging -print)
}

named_volume_size_kib() {
  local volume="$1"
  docker run --rm -v "$volume:/source:ro" \
    "${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}" \
    du -sk /source 2>/dev/null | awk 'NR==1 { print $1 }'
}

full_backup_capacity_preflight() {
  local host_dir="$1" seaweed_volume redis_volume n8n_volume seaweed_kib redis_kib n8n_kib db_kib available_kib required_kib
  seaweed_volume="$(container_named_volume taxtronik-seaweedfs /data)"
  redis_volume="$(container_named_volume taxtronik-redis /data)"
  n8n_volume="$(container_named_volume taxtronik-n8n /home/node/.n8n)"
  [[ -n "$seaweed_volume" && -n "$redis_volume" && -n "$n8n_volume" ]] || \
    die "Kapazitaets-Preflight kann Docker-Volumes nicht aufloesen."
  seaweed_kib="$(named_volume_size_kib "$seaweed_volume")"
  redis_kib="$(named_volume_size_kib "$redis_volume")"
  n8n_kib="$(named_volume_size_kib "$n8n_volume")"
  db_kib="$(docker exec taxtronik-postgres psql -U taxtronik -d taxtronik -tAc \
    "SELECT CEIL((pg_database_size('taxtronik') + pg_database_size('n8n')) / 1024.0)::bigint" | tr -d '[:space:]')"
  available_kib="$(df -Pk "$host_dir" | awk 'NR==2 { print $4 }')"
  [[ "$seaweed_kib" =~ ^[0-9]+$ && "$redis_kib" =~ ^[0-9]+$ && "$n8n_kib" =~ ^[0-9]+$ && \
     "$db_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]] || \
    die "Kapazitaets-Preflight konnte Groessen/freien Platz nicht belastbar ermitteln."
  # Peak: Byte-Export + Raw-Volume-Tars + parallel entstehendes age-Archiv.
  # Konservativ ohne Kompressionsgewinn, plus 1 GiB Arbeitsreserve.
  required_kib=$(( seaweed_kib * 5 + (redis_kib + n8n_kib + db_kib) * 3 + 1048576 ))
  (( available_kib >= required_kib )) || \
    die "Zu wenig freier Platz fuer Full-Backup: benoetigt konservativ ${required_kib} KiB, frei ${available_kib} KiB. BACKUP_HOST_DIR auf separates Backup-Dateisystem legen."
  info "Full-Backup-Kapazitaets-Preflight OK (frei ${available_kib} KiB, konservativer Bedarf ${required_kib} KiB)."
}

encrypt_full_backup_payload() {
  local payload="$1" dest="$2" recipient="${BACKUP_AGE_RECIPIENT:-}" root_files=(.env)
  require_cmd age
  [[ -n "$recipient" ]] || die "BACKUP_AGE_RECIPIENT fehlt. Full-Backup darf Konfiguration/Schluessel nur age-verschluesselt sichern."
  [[ -f "$STATE" ]] && root_files+=(.taxtronik.state)
  info "Gesamtes Full-Backup inklusive Recovery-Konfiguration age-verschluesseln"
  tar -cf - -C "$payload" . -C "$ROOT" "${root_files[@]}" | \
    age --recipient "$recipient" --output "$dest/full-backup.tar.age"
  chmod 0600 "$dest/full-backup.tar.age" 2>/dev/null || true
}

remove_full_backup_staging() {
  local staging="$1" expected_parent
  expected_parent="$(resolve_backup_host_dir)/full/"
  case "$staging" in
    "$expected_parent"*/.staging) rm -rf -- "$staging" ;;
    *) die "Unsicheres Staging-Cleanup verweigert: $staging" ;;
  esac
}

seal_full_backup() {
  local dest="$1" private_key="${BACKUP_MANIFEST_PRIVATE_KEY_FILE:-}" public_key="${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}"
  [[ -n "$private_key" && -f "$private_key" ]] || \
    die "BACKUP_MANIFEST_PRIVATE_KEY_FILE fehlt/ist unlesbar. Schluessel: node scripts/backup/manifest.mjs generate-key --out-dir <offline-pfad>"
  [[ -n "$public_key" && -f "$public_key" ]] || \
    die "BACKUP_MANIFEST_PUBLIC_KEY_FILE fehlt/ist unlesbar (Kopie getrennt/offline aufbewahren)."
  node "$ROOT/scripts/backup/manifest.mjs" create \
    --root "$dest" \
    --private-key "$private_key" \
    --version "$(image_tag)" \
    --commit "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  node "$ROOT/scripts/backup/manifest.mjs" verify \
    --root "$dest" \
    --public-key "$public_key"
}

offsite_backup_configured() {
  [[ -n "${BACKUP_OFFSITE_ENDPOINT:-}" && -n "${BACKUP_OFFSITE_BUCKET:-}" && \
     -n "${BACKUP_OFFSITE_ACCESS_KEY:-}" && -n "${BACKUP_OFFSITE_SECRET_KEY:-}" ]]
}

upload_full_backup_offsite() {
  local dest="$1" endpoint="${BACKUP_OFFSITE_ENDPOINT:-}" bucket="${BACKUP_OFFSITE_BUCKET:-}" prefix receipt min_days
  offsite_backup_configured || die "Offsite-Backup nicht vollstaendig konfiguriert (ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY)."
  [[ "$endpoint" == https://* ]] || die "BACKUP_OFFSITE_ENDPOINT muss HTTPS verwenden."
  [[ "$endpoint" != "${S3_ENDPOINT:-}" && "$endpoint" != *"seaweedfs"* ]] || \
    die "Offsite-Ziel darf nicht der lokale TaxTronik-Object-Store sein."
  min_days="${BACKUP_OFFSITE_MIN_RETENTION_DAYS:-90}"
  [[ "$min_days" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_OFFSITE_MIN_RETENTION_DAYS muss eine positive Ganzzahl sein."
  prefix="${BACKUP_OFFSITE_PREFIX:-taxtronik/full}/$(basename "$dest")"
  info "Signiertes Full-Backup in immutable Offsite-Bucket hochladen: s3://$bucket/$prefix"

  BACKUP_OFFSITE_ENDPOINT="$endpoint" \
  BACKUP_OFFSITE_BUCKET="$bucket" \
  BACKUP_OFFSITE_PREFIX="$prefix" \
  BACKUP_OFFSITE_MIN_RETENTION_DAYS="$min_days" \
  BACKUP_OFFSITE_ACCESS_KEY="$BACKUP_OFFSITE_ACCESS_KEY" \
  BACKUP_OFFSITE_SECRET_KEY="$BACKUP_OFFSITE_SECRET_KEY" \
  BACKUP_OFFSITE_REGION="${BACKUP_OFFSITE_REGION:-eu-central-1}" \
  docker run --rm \
    -e BACKUP_OFFSITE_ENDPOINT \
    -e BACKUP_OFFSITE_BUCKET \
    -e BACKUP_OFFSITE_PREFIX \
    -e BACKUP_OFFSITE_MIN_RETENTION_DAYS \
    -e BACKUP_OFFSITE_ACCESS_KEY \
    -e BACKUP_OFFSITE_SECRET_KEY \
    -e BACKUP_OFFSITE_REGION \
    -v "$dest:/backup:ro" \
    --entrypoint /bin/sh \
    "${TAXTRONIK_AWS_CLI_IMAGE:-$AWS_CLI_IMAGE_DEFAULT}" -ec '
      export AWS_ACCESS_KEY_ID="$BACKUP_OFFSITE_ACCESS_KEY"
      export AWS_SECRET_ACCESS_KEY="$BACKUP_OFFSITE_SECRET_KEY"
      export AWS_DEFAULT_REGION="$BACKUP_OFFSITE_REGION"
      aws_offsite() { aws --endpoint-url "$BACKUP_OFFSITE_ENDPOINT" "$@"; }
      MODE="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Mode --output text)"
      DAYS="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Days --output text)"
      YEARS="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Years --output text)"
      VERSIONING="$(aws_offsite s3api get-bucket-versioning --bucket "$BACKUP_OFFSITE_BUCKET" --query Status --output text)"
      test "$VERSIONING" = Enabled
      test "$MODE" = COMPLIANCE
      EFFECTIVE_DAYS=0
      case "$DAYS" in None|"") : ;; *) EFFECTIVE_DAYS="$DAYS" ;; esac
      case "$YEARS" in None|"") : ;; *) EFFECTIVE_DAYS=$((YEARS * 365)) ;; esac
      test "$EFFECTIVE_DAYS" -ge "$BACKUP_OFFSITE_MIN_RETENTION_DAYS"

      for FILE in full-backup.tar.age manifest.json manifest.json.sig; do
        test -f "/backup/$FILE"
        aws_offsite s3 cp "/backup/$FILE" "s3://$BACKUP_OFFSITE_BUCKET/$BACKUP_OFFSITE_PREFIX/$FILE" --only-show-errors
        HEAD="$(aws_offsite s3api head-object --bucket "$BACKUP_OFFSITE_BUCKET" \
          --key "$BACKUP_OFFSITE_PREFIX/$FILE" \
          --query "[ContentLength,ObjectLockMode,ObjectLockRetainUntilDate,VersionId,ETag]" --output text)"
        set -- $HEAD
        test "$1" = "$(wc -c < "/backup/$FILE" | tr -d " ")"
        test "$2" = COMPLIANCE
        test "$3" != None && test -n "$3"
        test "$4" != None && test -n "$4"
        printf "%s\t%s\t%s\t%s\t%s\n" "$FILE" "$1" "$3" "$4" "$5"
      done
    ' > "${dest}.offsite-receipt.txt"
  chmod 0600 "${dest}.offsite-receipt.txt" 2>/dev/null || true
  receipt="${dest}.offsite-receipt.txt"
  [[ "$(wc -l < "$receipt")" -eq 3 ]] || die "Offsite-Receipt unvollstaendig."
  info "Offsite-Upload fuer alle 3 Artefakte mit VersionId, Groesse und COMPLIANCE-Retention verifiziert (Receipt: $receipt)."
}

restore_needs_s3() {
  local arg
  for arg in "$@"; do
    [[ "$arg" == "--file" ]] && return 1
  done
  return 0
}

run_restore() {
  require_cmd pnpm
  info "Restore starten"
  generate_prisma_client_for_host_tools
  if ! command -v pg_restore >/dev/null 2>&1; then
    export PG_RESTORE_PATH="$ROOT/infra/scripts/pg_restore-via-container.sh"
    info "pg_restore fehlt auf dem Host -> nutze pg_restore aus dem Postgres-Container (PG_RESTORE_PATH)."
  fi
  if restore_needs_s3 "$@"; then
    ensure_s3_ready_for_backup
  fi
  ( cd "$ROOT" && pnpm --filter @taxtronik/web backup:restore -- "$@" )
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

wait_seaweedfs_healthy() {
  info "Warten bis SeaweedFS healthy ist"
  local deadline=$(( $(date +%s) + 120 )) s
  while :; do
    [[ $(date +%s) -ge $deadline ]] && die "SeaweedFS nach 120 s nicht healthy."
    s="$(docker inspect --format '{{.State.Health.Status}}' taxtronik-seaweedfs 2>/dev/null || true)"
    [[ "$s" == "healthy" ]] && { info "SeaweedFS healthy."; return 0; }
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
    printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app') THEN EXECUTE format('ALTER ROLE taxtronik_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %%L', %s); ELSE EXECUTE format('CREATE ROLE taxtronik_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %%L', %s); END IF; END \$\$;\n" "$app_pw" "$app_pw"
    printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN EXECUTE format('ALTER ROLE n8n WITH PASSWORD %%L', %s); END IF; END \$\$;\n" "$n8n_pw"
  } | docker exec -i taxtronik-postgres psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1
}

s3_preflight() {
  require_env S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY
  node --input-type=module <<'NODE'
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

try {
  const result = await client.send(new ListBucketsCommand({}));
  const backupBucket = process.env.S3_BUCKET_BACKUPS || 'backups';
  const buckets = result.Buckets?.map((bucket) => bucket.Name).filter(Boolean) ?? [];
  if (!buckets.includes(backupBucket)) {
    throw new Error(`Backup-Bucket '${backupBucket}' fehlt`);
  }
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error));
  console.error(`[s3-preflight] ${e.name}: ${e.message}`);
  process.exit(1);
}
NODE
}

reload_seaweedfs_credentials_from_env() {
  info "SeaweedFS-S3-Konfiguration aus .env neu laden"
  render_s3_config
  compose --infra up -d --force-recreate seaweedfs
  wait_seaweedfs_healthy
  docker rm -f taxtronik-seaweedfs-init >/dev/null 2>&1 || true
  compose --infra up -d seaweedfs-init
  local code
  code="$(docker wait taxtronik-seaweedfs-init 2>/dev/null || echo 1)"
  if [[ "$code" != "0" ]]; then
    compose --infra logs seaweedfs-init --tail 80 || true
    die "SeaweedFS-Bucket-Init fehlgeschlagen (Exit $code)."
  fi
}

ensure_s3_ready_for_backup() {
  info "S3-Preflight (SeaweedFS Credentials/Buckets)"
  if s3_preflight; then
    return 0
  fi
  warn "S3-Preflight fehlgeschlagen. Vermutlich laufen SeaweedFS-Credentials noch mit alter s3.json. Lade Object-Store aus .env neu."
  reload_seaweedfs_credentials_from_env
  s3_preflight || die "S3-Preflight auch nach SeaweedFS-Neuladen fehlgeschlagen. S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY pruefen."
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

configure_smtp_interactive() {
  local host_def port_def from_def input needs=0

  [[ -z "${SMTP_HOST:-}" || -z "${SMTP_PORT:-}" || -z "${SMTP_FROM:-}" ]] && needs=1
  smtp_points_to_dev_mailhog "${SMTP_HOST:-}" "${SMTP_PORT:-}" && needs=1
  (( needs == 1 )) || return 0

  if [[ ! -t 0 ]]; then
    warn "SMTP ist nicht produktionsbereit (Mailhog/localhost:1025 ist nur Dev) — bitte SMTP_HOST/SMTP_PORT/SMTP_FROM in .env setzen."
    return 0
  fi

  host_def="${SMTP_HOST:-smtp.example.de}"
  port_def="${SMTP_PORT:-587}"
  from_def="${SMTP_FROM:-noreply@example.de}"
  if smtp_points_to_dev_mailhog "$host_def" "$port_def"; then
    host_def="smtp.example.de"
    port_def="587"
  fi
  [[ "$from_def" == *"example.local"* ]] && from_def="noreply@example.de"

  read -rp "SMTP-Host (Prod-Relay; Mailhog nur Dev) [$host_def]: " input || true
  set_env SMTP_HOST "${input:-$host_def}"
  read -rp "SMTP-Port [$port_def]: " input || true
  set_env SMTP_PORT "${input:-$port_def}"
  read -rp "SMTP-Absender [$from_def]: " input || true
  set_env SMTP_FROM "${input:-$from_def}"
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

state_value() {
  local key="$1"
  [[ -f "$STATE" ]] || return 0
  grep -E "^${key}=" "$STATE" | head -n1 | cut -d= -f2- || true
}

# Schreibt den vollstaendigen Last-Good-Artefaktvertrag fuer Rollback.
# `previous` ist der zuvor erfolgreiche current-Stand; ein fehlgeschlagener
# Deploy erreicht diese Funktion nie und kann den Last-Good-Zeiger nicht
# ueberschreiben.
save_state() {
  local tmp new_version new_web new_worker new_commit
  local old_current old_web old_worker old_commit
  local previous previous_web previous_worker previous_commit
  new_version="$(image_tag)"
  new_web="${TAXTRONIK_WEB_DIGEST_SUFFIX:-}"
  new_worker="${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}"
  new_commit="${TAXTRONIK_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  old_current="$(state_value current)"
  old_web="$(state_value current_web_digest_suffix)"
  old_worker="$(state_value current_worker_digest_suffix)"
  old_commit="$(state_value current_commit)"

  if [[ "$new_version" == "$old_current" && "$new_web" == "$old_web" && \
        "$new_worker" == "$old_worker" && "$new_commit" == "$old_commit" ]]; then
    # Ein idempotenter Redeploy darf den echten N-1-Rollbackzeiger nicht durch
    # current=current zerstoeren.
    previous="$(state_value previous)"
    previous_web="$(state_value previous_web_digest_suffix)"
    previous_worker="$(state_value previous_worker_digest_suffix)"
    previous_commit="$(state_value previous_commit)"
  else
    previous="$old_current"
    previous_web="$old_web"
    previous_worker="$old_worker"
    previous_commit="$old_commit"
  fi

  tmp="$(mktemp "${STATE}.tmp.XXXXXX")" || die "Release-State konnte nicht angelegt werden."
  {
    printf 'previous=%s\n' "$previous"
    printf 'previous_web_digest_suffix=%s\n' "$previous_web"
    printf 'previous_worker_digest_suffix=%s\n' "$previous_worker"
    printf 'previous_commit=%s\n' "$previous_commit"
    printf 'current=%s\n' "$new_version"
    printf 'current_web_digest_suffix=%s\n' "$new_web"
    printf 'current_worker_digest_suffix=%s\n' "$new_worker"
    printf 'current_commit=%s\n' "$new_commit"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "Release-State konnte nicht auf 0600 gehaertet werden."; }
  mv -f "$tmp" "$STATE"
  chmod 0600 "$STATE" || die "Release-State konnte nicht auf 0600 gehaertet werden."
}

finalize_release_contract() {
  # Beide Aufrufe liegen bewusst erst hinter Health + Readiness. STATE ist der
  # massgebliche Last-Good-Zeiger und wird atomar vor den .env-Eintraegen
  # aktualisiert; jeder Zwischenzustand wird vom Compose-Guard abgewiesen.
  save_state
  commit_release_contract
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
  chmod 0600 "$ENVFILE" || die "Dateirechte fuer $ENVFILE konnten nicht auf 0600 gesetzt werden."
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

  configure_smtp_interactive

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

  reconcile_n8n_encryption_key_from_volume

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
  ( cd "$ROOT" && TENANT_NAME="$TENANT_NAME" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_CREDENTIALS_PATH="$ROOT/.admin-credentials.txt" \
      pnpm --filter @taxtronik/db provision ) \
    || warn "Provisionierung fehlgeschlagen — siehe Ausgabe."
}

cmd_reset_admin_password() {
  require_cmd pnpm
  require_cmd node
  load_env
  require_env DATABASE_URL

  generate_prisma_client_for_host_tools
  ( cd "$ROOT" && ADMIN_EMAIL="${ADMIN_EMAIL:-}" TENANT_SLUG="${TENANT_SLUG:-}" ADMIN_CREDENTIALS_PATH="$ROOT/.admin-credentials.txt" \
      pnpm --filter @taxtronik/db reset-admin-password )
  info "Admin-Passwort neu gesetzt. Credentials: $ROOT/.admin-credentials.txt"
}

# Gemeinsame Deploy-Sequenz (deploy + bootstrap). Enthaelt die Erstinstall-
# Erkennung, sodass deploy eine frische Installation komplett abdeckt.
_deploy_core() {
  load_env; preflight_common; assert_production_env; require_release_version
  prepare_release_contract
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  backup_before_migrations
  run_migrations
  ensure_provisioned_interactive
  start_apps
  smoke_health || die "Deploy abgebrochen: Anwendung ist nicht vollstaendig healthy."
  deploy_readiness || die "Deploy abgebrochen: Produktivkonfiguration ist nicht bereit."
  finalize_release_contract
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

  # Das Pflichtbackup muss vollstaendig mit dem bisher installierten Checkout
  # und dessen Prisma-Client laufen. Neuer Anwendungscode darf das noch alte
  # DB-Schema vor dessen Migration nicht abfragen. Erst ein erfolgreiches
  # Backup autorisiert daher ueberhaupt fetch/merge und damit eine Aenderung des
  # Arbeitsbaums.
  prepare_env_interactive
  load_env; preflight_common; assert_production_env; require_release_version
  if images_from_registry; then resolve_release_contract; fi
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  run_backup || die "Pflichtbackup fehlgeschlagen — Code und Arbeitsbaum bleiben unveraendert."

  info "Code auf den freigegebenen Stand aktualisieren (git ff-only)"
  cd "$ROOT"
  local remote target_ref
  remote="$(deployment_git_remote)"
  if images_from_registry; then
    fetch_verified_release_tag "$TAXTRONIK_VERSION" "$UPDATE_COMMIT_SHA"
    git merge --ff-only "$UPDATE_COMMIT_SHA"
  else
    git fetch "$remote"
    target_ref="${TAXTRONIK_UPDATE_REF:-$remote/main}"
    git merge --ff-only "$target_ref"
  fi
  # .env ggfs. aus dem aktualisierten Stand neu vervollstaendigen (Prod-Defaults,
  # fehlende Secrets, NEXTAUTH_URL) — wie bei deploy ohne Hand-Editiererei.
  prepare_env_interactive
  load_env; preflight_common; assert_production_env; require_release_version
  if images_from_registry; then
    verify_release_checkout
    stage_release_contract
  else
    prepare_release_contract
  fi
  # Der neue Checkout kann auch die Infra-Definition erweitert haben.
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  run_migrations
  start_apps
  smoke_health || die "Update fehlgeschlagen: Anwendung ist nicht vollstaendig healthy; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  deploy_readiness || die "Update fehlgeschlagen: Produktivkonfiguration ist nicht bereit; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  finalize_release_contract
  info "Update fertig. Version: $(image_tag)"
}

cmd_backup() {
  load_env; preflight_common; assert_production_env
  start_infra
  wait_postgres_healthy
  wait_seaweedfs_healthy
  sync_postgres_roles_from_env
  run_backup
  info "Backup fertig."
}

cmd_backup_files() {
  load_env; preflight_common; assert_production_env
  start_infra
  wait_seaweedfs_healthy
  ensure_s3_ready_for_backup
  run_backup_files
  info "Kanzleidateien-Backup fertig."
}

cmd_backup_full() {
  load_env; preflight_common; assert_production_env
  require_cmd age
  require_cmd flock
  start_infra
  wait_postgres_healthy
  wait_seaweedfs_healthy
  sync_postgres_roles_from_env
  compose up -d n8n

  local host_dir dest staging
  host_dir="$(resolve_backup_host_dir)"
  prepare_backup_host_dir
  exec 9>"$host_dir/.full-backup.lock"
  flock -n 9 || die "Ein anderes Full-Backup laeuft bereits."
  cleanup_abandoned_full_backup_staging
  full_backup_capacity_preflight "$host_dir"
  dest="$host_dir/full/$(date -u +'%Y%m%dT%H%M%SZ')"
  staging="$dest/.staging"
  _FULL_BACKUP_STAGING="$staging"
  mkdir -p "$staging/database" "$staging/object-store-byte-export" "$staging/volumes"
  chmod 0700 "$dest" 2>/dev/null || true
  trap 'full_backup_exit_cleanup $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Ein Full-Backup ist ein zusammengehoeriger Wiederanlaufpunkt. App, Worker
  # und n8n werden VOR DB-Dumps und Object-Export gestoppt, damit keine DB-
  # Referenz zwischen Dump und SeaweedFS-Snapshot neu entsteht/verschwindet.
  info "Schreibdienste fuer konsistenten Full-Backup-Wiederanlaufpunkt quieszieren"
  _FULL_BACKUP_SERVICES_QUIESCED=1
  compose stop app worker n8n || die "Schreibdienste konnten nicht vollstaendig gestoppt werden."
  if ! BACKUP_LOCAL_DIR="$staging/database" run_backup; then
    die "TaxTronik-DB-Dump im Full-Backup fehlgeschlagen."
  fi
  if ! run_backup_n8n "$staging/database"; then
    die "n8n-DB-Dump im Full-Backup fehlgeschlagen."
  fi
  if ! run_backup_files "$staging/object-store-byte-export"; then
    die "Object-Store-Byte-Export im Full-Backup fehlgeschlagen."
  fi
  run_cold_volume_snapshots "$staging/volumes" || die "Cold-Volume-Snapshot oder Wiederanlauf fehlgeschlagen."
  encrypt_full_backup_payload "$staging" "$dest"
  remove_full_backup_staging "$staging"
  _FULL_BACKUP_STAGING=""
  seal_full_backup "$dest"
  restart_after_full_backup || die "Full-Backup ist versiegelt, aber der Wiederanlauf der Dienste ist fehlgeschlagen."
  _FULL_BACKUP_SERVICES_QUIESCED=0
  trap - EXIT INT TERM
  flock -u 9
  exec 9>&-

  if offsite_backup_configured; then
    upload_full_backup_offsite "$dest"
  elif [[ "${BACKUP_OFFSITE_REQUIRED:-false}" == "true" ]]; then
    die "Lokales Full-Backup erstellt, aber BACKUP_OFFSITE_REQUIRED=true und kein vollstaendiges Offsite-Ziel konfiguriert: $dest"
  else
    warn "Full-Backup ist lokal versiegelt, aber noch nicht offsite: $dest"
  fi
  info "Vollbackup fertig: DB + n8n-DB + Byte-Export + Cold-Volumes + Recovery-Konfiguration gemeinsam age-verschluesselt; signiertes SHA-256-Manifest ($dest)."
}

cmd_backup_verify() {
  local dest="${1:-}" public_key="${2:-${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}}"
  [[ -n "$dest" && -d "$dest" ]] || die "Nutzung: ./taxtronik backup-verify <full-backup-verzeichnis>"
  require_cmd node
  [[ -n "$public_key" ]] || public_key="$(get_env BACKUP_MANIFEST_PUBLIC_KEY_FILE)"
  [[ -n "$public_key" && -f "$public_key" ]] || \
    die "Public Key fehlt. Als 2. Argument oder BACKUP_MANIFEST_PUBLIC_KEY_FILE uebergeben."
  node "$ROOT/scripts/backup/manifest.mjs" verify \
    --root "$dest" \
    --public-key "$public_key"
}

cmd_backup_decrypt() {
  local dest="${1:-}" target="${2:-}" identity="${3:-${BACKUP_AGE_IDENTITY_FILE:-}}" public_key="${4:-${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}}"
  [[ -n "$dest" && -d "$dest" && -f "$dest/full-backup.tar.age" ]] || \
    die "Nutzung: ./taxtronik backup-decrypt <full-backup-verzeichnis> <leeres-zielverzeichnis>"
  [[ -n "$target" ]] || die "Zielverzeichnis fuer entschluesselte Recovery-Artefakte fehlt."
  require_cmd age
  require_cmd tar
  [[ -n "$identity" ]] || identity="$(get_env BACKUP_AGE_IDENTITY_FILE)"
  [[ -n "$public_key" ]] || public_key="$(get_env BACKUP_MANIFEST_PUBLIC_KEY_FILE)"
  [[ -n "$identity" && -f "$identity" ]] || \
    die "age-Identity fehlt. Als 3. Argument oder BACKUP_AGE_IDENTITY_FILE am isolierten Restore-System uebergeben."
  if [[ -e "$target" && -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "Restore-Ziel muss leer sein: $target"
  fi
  mkdir -p "$target"
  chmod 0700 "$target" 2>/dev/null || true
  cmd_backup_verify "$dest" "$public_key"
  info "Full-Backup in isoliertes Ziel entschluesseln: $target"
  age --decrypt --identity "$identity" "$dest/full-backup.tar.age" | \
    tar --extract --file - --directory "$target" --no-same-owner --no-same-permissions
  [[ -d "$target/database" && -f "$target/volumes/seaweedfs-data.tar.gz" && \
     -f "$target/volumes/redis-data.tar.gz" && -f "$target/volumes/n8n-data.tar.gz" && \
     -f "$target/.env" ]] || die "Entschluesseltes Full-Backup ist unvollstaendig."
  tar -tzf "$target/volumes/seaweedfs-data.tar.gz" >/dev/null
  tar -tzf "$target/volumes/redis-data.tar.gz" >/dev/null
  tar -tzf "$target/volumes/n8n-data.tar.gz" >/dev/null
  info "Entschluesselung + Archiv-Strukturpruefung erfolgreich. Restore ausschliesslich nach DR-Runbook auf isoliertem Ziel fortsetzen."
}

cmd_backup_offsite() {
  local dest="${1:-}"
  [[ -n "$dest" && -d "$dest" ]] || die "Nutzung: ./taxtronik backup-offsite <full-backup-verzeichnis>"
  load_env
  cmd_backup_verify "$dest"
  upload_full_backup_offsite "$dest"
}

cmd_restore() {
  load_env; preflight_common; assert_production_env
  start_infra
  wait_postgres_healthy
  if restore_needs_s3 "$@"; then
    wait_seaweedfs_healthy
  fi
  sync_postgres_roles_from_env
  run_restore "$@"
  info "Restore fertig."
}

# Wird nur als EXIT-Recovery waehrend der Aktivierung eines Rollbacks gesetzt.
# .env und STATE sind zu diesem Zeitpunkt noch Last-Good; wir stellen zusaetzlich
# dessen Checkout und Container best-effort wieder her.
rollback_failure_recover() {
  local rc="${1:-1}" restore_commit="${_TAXTRONIK_ROLLBACK_LAST_GOOD_COMMIT:-}"
  trap - EXIT INT TERM
  [[ "${_TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED:-0}" == "1" ]] || exit "$rc"
  set +e
  warn "Rollback-Aktivierung fehlgeschlagen; Last-Good-Checkout und -Container werden wiederhergestellt."
  if [[ -z "$restore_commit" ]]; then restore_commit="${_TAXTRONIK_ROLLBACK_SOURCE_COMMIT:-}"; fi
  if [[ -n "${_TAXTRONIK_ROLLBACK_SOURCE_BRANCH:-}" && \
        "$restore_commit" == "${_TAXTRONIK_ROLLBACK_SOURCE_COMMIT:-}" ]]; then
    git -C "$ROOT" switch "$_TAXTRONIK_ROLLBACK_SOURCE_BRANCH" >/dev/null 2>&1
  else
    git -C "$ROOT" switch --detach "$restore_commit" >/dev/null 2>&1
  fi

  if [[ -n "${_TAXTRONIK_ROLLBACK_LAST_GOOD_VERSION:-}" ]]; then
    export TAXTRONIK_VERSION="$_TAXTRONIK_ROLLBACK_LAST_GOOD_VERSION"
    export TAXTRONIK_WEB_DIGEST_SUFFIX="${_TAXTRONIK_ROLLBACK_LAST_GOOD_WEB:-}"
    export TAXTRONIK_WORKER_DIGEST_SUFFIX="${_TAXTRONIK_ROLLBACK_LAST_GOOD_WORKER:-}"
    if [[ "${_TAXTRONIK_ROLLBACK_REGISTRY_MODE:-0}" == "1" ]]; then
      export TAXTRONIK_RELEASE_COMMIT="$restore_commit"
    else
      export TAXTRONIK_RELEASE_COMMIT=""
    fi
    export _TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED=1
    if ! start_apps; then
      warn "Automatischer Last-Good-Containerstart fehlgeschlagen; .env/STATE bleiben unveraendert und blockieren einen Mischbetrieb."
    fi
  fi
  exit "$rc"
}

# Rollback auf einen frueheren Artefakt- UND Code-Stand. KEINE DB-Migration
# (Prisma ist forward-only) — Schema-Aenderungen bleiben zurueck. Bei einem
# zuvor fehlgeschlagenen Update zeigt .env auf einen Pending-Stand; ohne
# Argument wird dann bewusst state.current (Last-Good) statt N-1 aktiviert.
cmd_rollback() {
  require_cmd docker; require_cmd node; require_cmd curl; require_cmd git
  load_env; preflight_common; assert_production_env
  local requested="${1:-}" target="" state_target="" state_web="" state_worker="" state_commit=""
  local current current_web current_worker current_commit previous previous_web previous_worker previous_commit
  local env_matches_current=0 prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" img registry_mode=0
  [[ -f "$STATE" ]] || die "Kein verifizierter Release-State in $STATE; Rollback wird verweigert."
  current="$(state_value current)"
  current_web="$(state_value current_web_digest_suffix)"
  current_worker="$(state_value current_worker_digest_suffix)"
  current_commit="$(state_value current_commit)"
  previous="$(state_value previous)"
  previous_web="$(state_value previous_web_digest_suffix)"
  previous_worker="$(state_value previous_worker_digest_suffix)"
  previous_commit="$(state_value previous_commit)"

  if images_from_registry; then
    registry_mode=1
    [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
       "$current_web" =~ ^@sha256:[0-9a-f]{64}$ && \
       "$current_worker" =~ ^@sha256:[0-9a-f]{64}$ && \
       "$current_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
      die "Current-Vertrag in $STATE ist unvollstaendig/ungueltig; Rollback wird fail-closed verweigert."
    if [[ "${TAXTRONIK_VERSION:-}" == "$current" && \
          "${TAXTRONIK_WEB_DIGEST_SUFFIX:-}" == "$current_web" && \
          "${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}" == "$current_worker" && \
          "${TAXTRONIK_RELEASE_COMMIT:-}" == "$current_commit" ]]; then
      env_matches_current=1
    fi
  else
    # Im Lokalbuild-Modus gibt es keine signierten Digest-Felder, also ist nur
    # die persistierte Version fuer die Pending-Erkennung relevant.
    [[ -n "$current" && "$current_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
      die "Current-Vertrag in $STATE ist unvollstaendig/ungueltig; Rollback wird fail-closed verweigert."
    [[ "${TAXTRONIK_VERSION:-}" == "$current" ]] && env_matches_current=1
  fi

  if [[ -n "$requested" ]]; then
    target="$requested"
  elif [[ $env_matches_current -eq 0 ]]; then
    target="$current"
    warn ".env/Prozessvertrag weicht von Last-Good ab; Rollback stellt state.current=$current wieder her."
  else
    target="$previous"
  fi
  [[ -n "$target" ]] || die "Kein Rollback-Ziel. Nutzung: ./taxtronik rollback <version> (oder gueltiges previous in $STATE)."

  if [[ "$target" == "$current" ]]; then
    state_target="$current"; state_web="$current_web"; state_worker="$current_worker"; state_commit="$current_commit"
  elif [[ "$target" == "$previous" ]]; then
    state_target="$previous"; state_web="$previous_web"; state_worker="$previous_worker"; state_commit="$previous_commit"
  fi

  export TAXTRONIK_VERSION="$target"
  if [[ $registry_mode -eq 1 ]]; then
    [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Registry-Rollback braucht SemVer X.Y.Z: $target"
    if [[ "$target" == "$state_target" && "$state_web" =~ ^@sha256:[0-9a-f]{64}$ && \
          "$state_worker" =~ ^@sha256:[0-9a-f]{64}$ && \
          "$state_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
      UPDATE_WEB_DIGEST="${state_web#@}"
      UPDATE_WORKER_DIGEST="${state_worker#@}"
      UPDATE_COMMIT_SHA="$state_commit"
      UPDATE_MIGRATIONS_REQUIRED=""
    else
      resolve_release_contract
      state_commit="$UPDATE_COMMIT_SHA"
    fi
    stage_release_contract
    fetch_verified_release_tag "$target" "$UPDATE_COMMIT_SHA"
    # Images und OCI-Labels werden vor dem Checkout-Wechsel validiert. Dadurch
    # bleibt ein Pull-/Registry-Fehler vollstaendig ohne Aktivierungswirkung.
    pull_release_images_direct
  else
    [[ "$target" == "$state_target" && "$state_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
      die "Lokalbuild-Rollback ist nur auf current/previous aus $STATE mit verifiziertem Commit moeglich."
    git -C "$ROOT" cat-file -e "${state_commit}^{commit}" 2>/dev/null || \
      die "Rollback-Commit $state_commit ist im lokalen Repository nicht vorhanden."
    stage_release_contract
    for img in web worker; do
      if ! docker image inspect "$prefix/$img:$target" >/dev/null 2>&1; then
        die "Image $prefix/$img:$target nicht lokal vorhanden (Lokalbuild-Modus)."
      fi
    done
  fi

  require_clean_release_checkout
  git -C "$ROOT" cat-file -e "${current_commit}^{commit}" 2>/dev/null || \
    die "Last-Good-Commit $current_commit ist lokal nicht vorhanden; sichere Rollback-Recovery nicht moeglich."
  export _TAXTRONIK_ROLLBACK_SOURCE_COMMIT
  export _TAXTRONIK_ROLLBACK_SOURCE_BRANCH
  export _TAXTRONIK_ROLLBACK_LAST_GOOD_VERSION="$current"
  export _TAXTRONIK_ROLLBACK_LAST_GOOD_WEB="$current_web"
  export _TAXTRONIK_ROLLBACK_LAST_GOOD_WORKER="$current_worker"
  export _TAXTRONIK_ROLLBACK_LAST_GOOD_COMMIT="$current_commit"
  export _TAXTRONIK_ROLLBACK_REGISTRY_MODE="$registry_mode"
  export _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED=0
  _TAXTRONIK_ROLLBACK_SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
  _TAXTRONIK_ROLLBACK_SOURCE_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
  trap 'rollback_failure_recover $?' EXIT
  trap 'exit 130' INT TERM
  git -C "$ROOT" switch --detach "$state_commit"
  export _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED=1

  warn "Rollback auf $target — KEINE DB-Migration (Prisma forward-only). Schema-Aenderungen bleiben zurueck."
  start_apps
  smoke_health || die "Rollback-Container sind gestartet, aber nicht healthy."
  deploy_readiness || die "Rollback-Container sind gestartet, aber die Produktivkonfiguration ist nicht bereit."

  # Die Aktivierung ist fachlich erfolgreich. Ab hier keinen automatischen
  # Ruecksprung mehr; STATE/.env werden als neuer Last-Good-Stand verankert.
  trap - EXIT INT TERM
  finalize_release_contract
  unset _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED
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
