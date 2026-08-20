#!/usr/bin/env bash
# =============================================================================
# Shared helpers für die taxtronik Operator-CLI (./taxtronik).
#
# Wird von ./taxtronik gesourcet. Enthält:
#   - .env-Laden + Secret-Generierung (ensure_secret)
#   - docker-compose-Wrapper (compose) — ehemals ./dc, jetzt eingebettet
#   - doctor: vorab .env-Validierung statt telemetrischem Mid-Deploy-Abbruch
#   - deploy: Erstkonfiguration + Build + Migration + Start + Smoke
#   - bootstrap: veralteter Kompatibilitätsalias für deploy
#   - update/backup/rollback: weitere Operator-Abläufe
#
# Dev/Prod-Trennung: auf dem Server läuft NUR Prod. .env auf dem Server ist
# immer eine Prod-.env (erzeugt via ./taxtronik deploy). Das Dev-setup
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
TRAEFIK="$ROOT/infra/compose/docker-compose.traefik.yml"
TRAEFIK_DYNAMIC="$ROOT/.taxtronik.traefik-dynamic.yml"
S3_GENERATED="$ROOT/infra/scripts/seaweedfs-s3.generated.json"
STATE="$ROOT/.taxtronik.state"
MIGRATION_PENDING="$ROOT/.taxtronik.migration-pending"
DB_RESTORE_AUTHORIZATION="$ROOT/.taxtronik.database-restored"
INSTALL_PENDING="$ROOT/.taxtronik.install-pending"
AWS_CLI_IMAGE_DEFAULT="amazon/aws-cli:latest@sha256:c95ab0642137f55a12b95b6956dd03cefdbd73e760e0e7b870afc9b47f9c8150"
ALPINE_BACKUP_IMAGE_DEFAULT="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
# Der Wert wird zusammen mit einem TaxTronik-Release getestet und angehoben.
# `SIGNAL_IMAGE=auto` folgt genau diesem Pin; ein externer/nativer Dienst wird
# dagegen niemals ueber diesen Pfad angefasst.
SIGNAL_MANAGED_IMAGE_DEFAULT="git.hirschmann-koxha.de/taxtronik/risk-layer-engine:v0.1.0"
SIGNAL_GIT_URL_DEFAULT="https://git.hirschmann-koxha.de/TaxTronik/signal.git"
SIGNAL_GIT_REF_DEFAULT="main"
TAXTRONIK_RELEASE_IMAGE_PREFIX_DEFAULT="git.hirschmann-koxha.de/taxtronik"
HOST_NODE_VERSION="24.19.0"
HOST_NODE_LINUX_X64_SHA256="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"
HOST_NODE_LINUX_ARM64_SHA256="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc"
HOST_PNPM_VERSION="11.20.0"

# Interne Autorisierungen gelten nur im dynamischen Scope der unten definierten
# Aktivierungs-Wrapper. Geerbte Shell-Variablen duerfen einen Operator-Aufruf
# niemals autorisieren (auch nicht den bestehenden Release-Contract-Guard).
while IFS= read -r _taxtronik_internal_name; do
  unset "$_taxtronik_internal_name"
done < <(compgen -A variable _TAXTRONIK_INTERNAL_ || true)
unset _taxtronik_internal_name

# ---------------------------------------------------------------------------
# Ausgabe-Helper
# ---------------------------------------------------------------------------
info() { printf '\n[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] !! %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
die()  { echo "FEHLER: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Command '$1' nicht gefunden."; }

node_version_supported() {
  command -v node >/dev/null 2>&1 || return 1
  local version major minor patch
  version="$(node --version 2>/dev/null)"; version="${version#v}"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" == "24" && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 1
  (( 10#$minor > 11 || (10#$minor == 11 && 10#$patch >= 0) ))
}

docker_cli_available() { command -v docker >/dev/null 2>&1; }

require_root_for_one_click() {
  [[ "$(id -u)" == "0" ]] || \
    die "Der bestaetigte 1-Klick-Pfad muss als root laufen, um Host-Pakete sicher zu installieren."
}

install_one_click_base_packages() {
  local missing=() cmd
  for cmd in curl git tar xz sha256sum getent ss openssl flock; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  (( ${#missing[@]} > 0 )) || return 0
  command -v apt-get >/dev/null 2>&1 || \
    die "1-Klick kann fehlende Basispakete nur auf Debian/Ubuntu per apt installieren (fehlt: ${missing[*]})."
  info "Fehlende Host-Basispakete installieren: ${missing[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git tar xz-utils coreutils libc-bin iproute2 openssl util-linux
}

configure_official_docker_apt_repository() {
  [[ -r /etc/os-release ]] || die "1-Klick kann das Betriebssystem nicht erkennen."
  local os_id="" codename="" arch="" key_tmp="" sources_tmp=""
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID:-}"; codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  [[ "$os_id" == "ubuntu" || "$os_id" == "debian" ]] || \
    die "Automatische Docker-Installation ist nur fuer Debian/Ubuntu freigegeben (erkannt: ${os_id:-unbekannt})."
  [[ "$codename" =~ ^[a-z0-9._-]+$ ]] || die "Ungueltiger Debian/Ubuntu-Codename: $codename"
  arch="$(dpkg --print-architecture)"
  [[ "$arch" =~ ^[a-z0-9]+$ ]] || die "Ungueltige dpkg-Architektur: $arch"

  install -d -m 0755 /etc/apt/keyrings
  key_tmp="$(mktemp /etc/apt/keyrings/docker.asc.tmp.XXXXXX)"
  curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
    "https://download.docker.com/linux/${os_id}/gpg" --output "$key_tmp" || {
      rm -f -- "$key_tmp"
      die "Offizieller Docker-Repository-Key konnte nicht geladen werden."
    }
  chmod 0644 "$key_tmp"
  mv -f -- "$key_tmp" /etc/apt/keyrings/docker.asc

  sources_tmp="$(mktemp /etc/apt/sources.list.d/docker.sources.tmp.XXXXXX)"
  {
    printf 'Types: deb\n'
    printf 'URIs: https://download.docker.com/linux/%s\n' "$os_id"
    printf 'Suites: %s\n' "$codename"
    printf 'Components: stable\n'
    printf 'Architectures: %s\n' "$arch"
    printf 'Signed-By: /etc/apt/keyrings/docker.asc\n'
  } >"$sources_tmp"
  chmod 0644 "$sources_tmp"
  mv -f -- "$sources_tmp" /etc/apt/sources.list.d/docker.sources
}

start_docker_daemon() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker
  elif command -v service >/dev/null 2>&1; then
    service docker start
  else
    die "Docker wurde installiert, aber weder systemctl noch service ist verfuegbar."
  fi
}

docker_one_click_toolchain_ready() {
  docker_cli_available && \
    docker info >/dev/null 2>&1 && \
    docker compose version >/dev/null 2>&1 && \
    docker buildx version >/dev/null 2>&1 && \
    docker buildx build --help 2>/dev/null | grep -Fq -- '--resource'
}

remove_conflicting_docker_packages_on_blank_host() {
  local installed=() package status
  for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    status="$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)"
    [[ "$status" == "ii " ]] && installed+=("$package")
  done
  (( ${#installed[@]} == 0 )) || {
    info "Unvollstaendige Distribution-Docker-Pakete auf leerem Host ersetzen: ${installed[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get remove -y "${installed[@]}"
  }
}

install_one_click_docker() {
  docker_one_click_toolchain_ready && return 0
  info "Docker Engine + Buildx + Compose aus dem offiziellen Docker-Repository installieren"
  configure_official_docker_apt_repository
  apt-get update
  remove_conflicting_docker_packages_on_blank_host
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  start_docker_daemon
  docker_one_click_toolchain_ready || \
    die "Docker ist installiert, aber Daemon, Compose v2, Buildx oder sicherer --resource-Buildvertrag fehlt."
}

managed_node_install_path() { printf '/opt/taxtronik/runtime/node-v%s' "$HOST_NODE_VERSION"; }

install_one_click_node() {
  if node_version_supported && command -v corepack >/dev/null 2>&1; then
    return 0
  fi
  local arch="" platform="" checksum="" archive="" staging="" destination=""
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      platform="x64"; checksum="$HOST_NODE_LINUX_X64_SHA256" ;;
    aarch64|arm64)
      platform="arm64"; checksum="$HOST_NODE_LINUX_ARM64_SHA256" ;;
    *) die "Node-$HOST_NODE_VERSION-Autoinstall unterstuetzt diese Architektur nicht: $arch" ;;
  esac
  archive="$(mktemp "/tmp/node-v${HOST_NODE_VERSION}.XXXXXX.tar.xz")"
  staging="$(mktemp -d "/tmp/node-v${HOST_NODE_VERSION}.XXXXXX")"
  destination="$(managed_node_install_path)"
  info "Offizielles Node.js v$HOST_NODE_VERSION fuer linux-$platform laden und SHA-256 pruefen"
  if ! curl --proto '=https' --tlsv1.2 --retry 3 --fail --silent --show-error \
      "https://nodejs.org/download/release/v${HOST_NODE_VERSION}/node-v${HOST_NODE_VERSION}-linux-${platform}.tar.xz" \
      --output "$archive"; then
    rm -f -- "$archive"; rmdir "$staging" 2>/dev/null || true
    die "Node.js-Archiv konnte nicht geladen werden."
  fi
  if ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
    rm -f -- "$archive"; rmdir "$staging" 2>/dev/null || true
    die "SHA-256-Pruefung des Node.js-Archivs ist fehlgeschlagen."
  fi
  tar -xJf "$archive" --strip-components=1 -C "$staging" || {
    rm -f -- "$archive"
    die "Node.js-Archiv konnte nicht entpackt werden."
  }
  rm -f -- "$archive"
  "$staging/bin/node" --version | grep -Fxq "v$HOST_NODE_VERSION" || \
    die "Entpackte Node.js-Laufzeit hat nicht die erwartete Version."
  install -d -m 0755 /opt/taxtronik/runtime /usr/local/bin
  if [[ -e "$destination" ]]; then
    [[ -x "$destination/bin/node" && "$("$destination/bin/node" --version)" == "v$HOST_NODE_VERSION" ]] || \
      die "Vorhandenes verwaltetes Node-Ziel ist ungueltig: $destination"
    rm -rf -- "$staging"
  else
    mv -- "$staging" "$destination"
  fi
  local executable link
  for executable in node npm npx corepack; do
    link="/usr/local/bin/$executable"
    [[ ! -e "$link" || -L "$link" ]] || \
      die "$link ist eine fremd verwaltete Datei; automatische Ueberschreibung wird verweigert."
    ln -sfn -- "$destination/bin/$executable" "$link"
  done
  export PATH="/usr/local/bin:$PATH"
  hash -r
  node_version_supported || die "Node.js v$HOST_NODE_VERSION ist nach Installation nicht aktiv."
}

install_one_click_pnpm() {
  export PATH="/usr/local/bin:$PATH"
  require_cmd corepack
  if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version 2>/dev/null)" == "$HOST_PNPM_VERSION" ]]; then
    return 0
  fi
  info "Corepack/pnpm $HOST_PNPM_VERSION aktivieren"
  corepack install --global "pnpm@$HOST_PNPM_VERSION"
  corepack enable pnpm --install-directory /usr/local/bin
  hash -r
  [[ "$(pnpm --version)" == "$HOST_PNPM_VERSION" ]] || \
    die "pnpm $HOST_PNPM_VERSION ist nach Corepack-Aktivierung nicht verfuegbar."
}

install_one_click_host_requirements() {
  require_root_for_one_click
  install_one_click_base_packages
  install_one_click_docker
  install_one_click_node
  install_one_click_pnpm
  require_cmd git; require_cmd curl
}

one_click_public_ports_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn 'sport = :80' 2>/dev/null | grep -q . || \
      ss -H -ltn 'sport = :443' 2>/dev/null | grep -q .
  else
    awk '$4 == "0A" && ($2 ~ /:0050$/ || $2 ~ /:01BB$/) { found=1 } END { exit !found }' \
      /proc/net/tcp /proc/net/tcp6 2>/dev/null
  fi
}

one_click_traefik_owns_public_ports() {
  [[ "$(docker inspect --format '{{.State.Running}}' taxtronik-traefik 2>/dev/null || true)" == "true" ]] || return 1
  docker port taxtronik-traefik 80/tcp 2>/dev/null | grep -Eq '(^|:)80$' && \
    docker port taxtronik-traefik 443/tcp 2>/dev/null | grep -Eq '(^|:)443$'
}

one_click_has_only_owned_containers() {
  local containers="$1" expected_project id name project
  [[ -n "$containers" ]] || return 1
  expected_project="$(_compose_project_name)"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    name="$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null || true)"
    name="${name#/}"
    case "$name" in
      taxtronik-postgres|taxtronik-redis|taxtronik-seaweedfs|taxtronik-seaweedfs-init|taxtronik-clamav|\
      taxtronik-app|taxtronik-backup-dir-init|taxtronik-worker|taxtronik-migrate|taxtronik-n8n|\
      taxtronik-risk-layer|taxtronik-eric-bridge|taxtronik-traefik) ;;
      *) return 1 ;;
    esac
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null || true)"
    [[ "$project" == "$expected_project" ]] || return 1
  done <<<"$containers"
}

initial_install_pending_is_valid() {
  [[ -f "$INSTALL_PENDING" ]] && grep -Fxq 'method=traefik' "$INSTALL_PENDING" 2>/dev/null
}

one_click_partial_install_can_resume() {
  [[ -f "$ENVFILE" && ! -e "$STATE" ]] || return 1
  # Neue Installationen tragen ab der ausdruecklichen Leerhost-Bestaetigung
  # einen Marker. Damit duerfen auch spaetere, von den eigentlichen
  # Recovery-Gates geschuetzte Deploy-Phasen fortgesetzt werden. Fuer einen
  # Legacy-Abbruch ohne Marker bleibt der Nachweis absichtlich enger.
  if ! initial_install_pending_is_valid; then
    [[ ! -e "$MIGRATION_PENDING" && ! -e "$DB_RESTORE_AUTHORIZATION" ]] || return 1
  fi
  docker_cli_available || return 1
  local containers
  containers="$(docker ps -aq 2>/dev/null)" || return 1
  one_click_has_only_owned_containers "$containers" || return 1
  if one_click_public_ports_in_use; then
    one_click_traefik_owns_public_ports || return 1
  fi
}

mark_initial_install_pending() {
  [[ "$(deployment_method)" == "traefik" ]] || return 0
  initial_install_pending_is_valid && return 0
  local tmp
  tmp="$(mktemp "${INSTALL_PENDING}.tmp.XXXXXX")" || die "Installationsmarker konnte nicht angelegt werden."
  {
    printf 'method=traefik\n'
    printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$tmp"
  chmod 0600 "$tmp" || { rm -f -- "$tmp"; die "Installationsmarker konnte nicht gehaertet werden."; }
  mv -f -- "$tmp" "$INSTALL_PENDING"
}

ensure_bootstrap_host_requirements() {
  local method
  method="$(deployment_method)" || die "DEPLOYMENT_METHOD muss standard oder traefik sein."
  if [[ "$method" == "traefik" ]]; then
    if [[ -f "$STATE" ]]; then
      require_cmd docker; require_cmd node; require_cmd git; require_cmd curl; require_cmd pnpm
      node_version_supported || die "Bestehender 1-Klick-Host braucht Node.js >=24.11.0 <25."
      docker info >/dev/null 2>&1 || die "Docker-Daemon ist nicht erreichbar."
      docker compose version >/dev/null 2>&1 || die "Docker Compose v2 fehlt."
      return 0
    fi
    if one_click_partial_install_can_resume; then
      info "Unterbrochenes eigenes 1-Klick-Deployment erkannt - vorhandene TaxTronik-Container werden sicher weiterverwendet."
      mark_initial_install_pending
      install_one_click_host_requirements
      return 0
    fi
    assert_blank_host_for_traefik
    install_one_click_host_requirements
  else
    require_cmd docker; require_cmd node; require_cmd git; require_cmd curl; require_cmd pnpm
    node_version_supported || \
      die "Standard-Setup braucht Node.js >=24.11.0 <25; Host-Pakete bleiben in diesem Modus Betreiberaufgabe."
    docker info >/dev/null 2>&1 || die "Docker-Daemon ist nicht erreichbar."
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 fehlt."
  fi
}

# ---------------------------------------------------------------------------
# .env laden / schreiben
# ---------------------------------------------------------------------------
load_env() {
  [[ -f "$ENVFILE" ]] || die "$ENVFILE nicht gefunden. Prod: ./taxtronik deploy. Dev: ./scripts/setup.sh"
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
  local esc; esc="$(printf '%s\n' "$value" | sed -e 's/[\\\/&|]/\\&/g')"
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
# Signal-Besitzvertrag
# ---------------------------------------------------------------------------
signal_deployment_mode() {
  local configured="${SIGNAL_DEPLOYMENT:-$(get_env SIGNAL_DEPLOYMENT)}"
  case "$configured" in
    managed|external|disabled) printf '%s' "$configured"; return 0 ;;
    "") ;;
    *) return 1 ;;
  esac

  # Bestandskompatibilitaet: nur der exakte Compose-DNS-Name bedeutet, dass
  # TaxTronik den Dienst bislang selbst betrieben hat. Jede andere URL bleibt
  # fremdverwaltet; aus einer URL wird niemals still Eigentum abgeleitet.
  local url="${RISK_LAYER_URL:-$(get_env RISK_LAYER_URL)}"
  if [[ -z "$url" ]]; then printf 'disabled'
  elif [[ "${url%/}" == "http://risk-layer:8000" ]]; then printf 'managed'
  else printf 'external'; fi
}

signal_managed_image() {
  local configured="${SIGNAL_IMAGE:-$(get_env SIGNAL_IMAGE)}"
  [[ -n "$configured" && "$configured" != "auto" ]] \
    && printf '%s' "$configured" \
    || printf '%s' "$SIGNAL_MANAGED_IMAGE_DEFAULT"
}

signal_deploy_channel() {
  local configured="${SIGNAL_DEPLOY_CHANNEL:-$(get_env SIGNAL_DEPLOY_CHANNEL)}"
  case "${configured:-image}" in
    source|image) printf '%s' "${configured:-image}" ;;
    *) return 1 ;;
  esac
}

valid_signal_git_url() {
  local value="${1:-}"
  if [[ "$value" =~ ^https://[^[:space:]]+$ ]]; then
    [[ "${value#https://}" != *@* && "$value" != *\?* && "$value" != *#* ]]
  else
    [[ "$value" =~ ^ssh://[^[:space:]@]+@[^[:space:]]+$ || \
       "$value" =~ ^git@[^[:space:]:]+:[^[:space:]]+$ ]]
  fi
}

valid_signal_git_ref() {
  local value="${1:-}"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && \
     "$value" != *..* && "$value" != *//* && "$value" != *@\{* && \
     "$value" != */ && "$value" != *\.lock ]]
}

signal_source_dir() {
  local configured="${SIGNAL_GIT_DIR:-$(get_env SIGNAL_GIT_DIR)}"
  if [[ -n "$configured" ]]; then
    printf '%s' "$configured"
  else
    printf '%s/signal' "$(dirname "$ROOT")"
  fi
}

validate_signal_source_image() {
  [[ "${1:-}" =~ ^taxtronik/risk-layer-engine:source-[0-9a-f]{12}$ ]]
}

validate_signal_managed_image() {
  local image="$1"
  [[ "$image" =~ ^[a-zA-Z0-9._-]+(:[0-9]+)?/[a-zA-Z0-9._/-]+(@sha256:[0-9a-f]{64}|:v[0-9]+\.[0-9]+\.[0-9]+)$ ]] || \
    return 1
  [[ "$image" != *:latest ]]
}

prepare_signal_managed_environment() {
  [[ "$(signal_deployment_mode)" == "managed" ]] || return 0
  local channel resolved
  channel="$(signal_deploy_channel)" || \
    die "SIGNAL_DEPLOY_CHANNEL muss source oder image sein."
  if [[ "$channel" == "source" ]]; then
    resolved="${SIGNAL_IMAGE:-$(get_env SIGNAL_IMAGE)}"
    validate_signal_source_image "$resolved" || \
      die "Signal-Source-Image wurde noch nicht gebaut. deploy/update verwenden."
    export SIGNAL_IMAGE="$resolved"
    return 0
  fi
  resolved="$(signal_managed_image)"
  validate_signal_managed_image "$resolved" || \
    die "SIGNAL_IMAGE muss ein versionierter vX.Y.Z-Tag oder sha256-Digest sein (aktuell: $resolved)."
  # Prozess-Override hat Vorrang vor .env. `auto` bleibt persistent und kann so
  # mit einem spaeteren TaxTronik-Release auf dessen getesteten Pin weiterziehen.
  export SIGNAL_IMAGE="$resolved"
}

# ---------------------------------------------------------------------------
# Deployment-Oberflaeche (vorhandener Proxy oder verwaltetes Traefik)
# ---------------------------------------------------------------------------
deployment_method() {
  local configured="${DEPLOYMENT_METHOD:-$(get_env DEPLOYMENT_METHOD)}"
  case "${configured:-standard}" in
    standard|traefik) printf '%s' "${configured:-standard}" ;;
    *) return 1 ;;
  esac
}

deployment_channel() {
  local configured="${TAXTRONIK_DEPLOY_CHANNEL:-$(get_env TAXTRONIK_DEPLOY_CHANNEL)}"
  case "$configured" in
    source|release) printf '%s' "$configured" ;;
    "")
      local prefix="${TAXTRONIK_IMAGE_PREFIX:-$(get_env TAXTRONIK_IMAGE_PREFIX)}"
      [[ "$prefix" == */* ]] && printf 'release' || printf 'source'
      ;;
    *) return 1 ;;
  esac
}

source_version_for_checkout() {
  local commit
  commit="$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null || true)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || \
    die "Source-Deployment braucht einen gueltigen Git-Checkout mit HEAD-Commit."
  printf 'source-%s' "${commit:0:12}"
}

prepare_source_version_for_checkout() {
  [[ "$(deployment_channel)" == "source" ]] || return 0
  export TAXTRONIK_DEPLOY_CHANNEL=source
  export TAXTRONIK_IMAGE_PREFIX=taxtronik
  export TAXTRONIK_VERSION="$(source_version_for_checkout)"
}

valid_public_fqdn() {
  local host="${1,,}"
  (( ${#host} <= 253 )) &&
    [[ "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

valid_setup_email() {
  local value="${1:-}"
  [[ "$value" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

render_traefik_dynamic_config() {
  [[ "$(deployment_method)" == "traefik" ]] || return 0
  local staff_url portal_url staff_host portal_host n8n_host acme_email tmp
  staff_url="${NEXTAUTH_URL:-$(get_env NEXTAUTH_URL)}"
  portal_url="${PORTAL_PUBLIC_URL:-$(get_env PORTAL_PUBLIC_URL)}"
  acme_email="${TRAEFIK_ACME_EMAIL:-$(get_env TRAEFIK_ACME_EMAIL)}"
  staff_host="$(url_hostname "$staff_url")"
  portal_host="$(url_hostname "$portal_url")"
  n8n_host="${N8N_HOST:-$(get_env N8N_HOST)}"
  staff_host="${staff_host,,}"; portal_host="${portal_host,,}"
  n8n_host="${n8n_host,,}"

  valid_public_fqdn "$staff_host" || \
    die "Traefik braucht eine gueltige Kanzlei-/Mitarbeiterportal-Domain in NEXTAUTH_URL."
  valid_public_fqdn "$portal_host" || \
    die "Traefik braucht eine gueltige Mandantenportal-Domain in PORTAL_PUBLIC_URL."
  valid_public_fqdn "$n8n_host" || \
    die "Traefik braucht eine gueltige n8n-Domain in N8N_HOST."
  [[ "$staff_host" != "$portal_host" && "$staff_host" != "$n8n_host" && "$portal_host" != "$n8n_host" ]] || \
    die "Kanzleiportal, Mandantenportal und n8n brauchen drei getrennte Domains."
  valid_setup_email "$acme_email" || \
    die "TRAEFIK_ACME_EMAIL fehlt oder ist ungueltig."

  tmp="$(mktemp "${TRAEFIK_DYNAMIC}.tmp.XXXXXX")" || \
    die "Temp-Datei fuer Traefik-Routen konnte nicht erzeugt werden."
  {
    printf 'http:\n'
    printf '  routers:\n'
    printf '    taxtronik-staff:\n'
    printf '      rule: "Host(`%s`)"\n' "$staff_host"
    printf '      entryPoints: [websecure]\n'
    printf '      service: taxtronik-app\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '    taxtronik-portal:\n'
    printf '      rule: "Host(`%s`)"\n' "$portal_host"
    printf '      entryPoints: [websecure]\n'
    printf '      service: taxtronik-app\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '    taxtronik-n8n:\n'
    printf '      rule: "Host(`%s`)"\n' "$n8n_host"
    printf '      entryPoints: [websecure]\n'
    printf '      service: taxtronik-n8n\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '  services:\n'
    printf '    taxtronik-app:\n'
    printf '      loadBalancer:\n'
    printf '        servers:\n'
    printf '          - url: "http://app:3000"\n'
    printf '    taxtronik-n8n:\n'
    printf '      loadBalancer:\n'
    printf '        servers:\n'
    printf '          - url: "http://n8n:5678"\n'
    printf 'tls:\n'
    printf '  options:\n'
    printf '    default:\n'
    printf '      minVersion: VersionTLS12\n'
  } >"$tmp"
  chmod 0600 "$tmp" || { rm -f -- "$tmp"; die "Traefik-Routen konnten nicht gehaertet werden."; }
  mv -f -- "$tmp" "$TRAEFIK_DYNAMIC"
  chmod 0600 "$TRAEFIK_DYNAMIC" || die "Traefik-Routen konnten nicht auf 0600 gehaertet werden."
  export TRAEFIK_DYNAMIC_CONFIG_PATH="$TRAEFIK_DYNAMIC"
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
  images_from_registry || return 0
  [[ "$prefix" == */* ]] || die "Release-Kanal braucht einen Registry-Prefix mit Slash."
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
  if [[ "${1:-}" == "--infra" ]]; then
    shift
    render_s3_config
    docker compose -f "$BASE" --env-file "$ENVFILE" "$@"
  else
    local compose_files=(-f "$BASE" -f "$APP") method
    case "${1:-}" in
      up|start|restart) assert_writer_start_authorized ;;
    esac
    render_s3_config
    ensure_compose_image_pinning
    method="$(deployment_method)" || die "DEPLOYMENT_METHOD muss standard oder traefik sein."
    if [[ "$method" == "traefik" ]]; then
      render_traefik_dynamic_config
      compose_files+=(-f "$TRAEFIK")
    fi
    if [[ "${1:-}" == "up" ]]; then
      reconcile_n8n_encryption_key_from_volume
    fi
    docker compose "${compose_files[@]}" --env-file "$ENVFILE" "$@"
  fi
}

# ---------------------------------------------------------------------------
# Versions-/Image-Logik
# ---------------------------------------------------------------------------
app_port() { printf '%s' "${APP_BIND_PORT:-3000}"; }
image_tag() { printf '%s' "${TAXTRONIK_VERSION:-latest}"; }

# Der explizite Bezugsweg ist die Wahrheit. Fuer bestehende Installationen ohne
# TAXTRONIK_DEPLOY_CHANNEL bleibt deployment_channel() bestandskompatibel und
# leitet den Modus einmalig aus dem bisherigen Image-Prefix ab.
images_from_registry() { [[ "$(deployment_channel)" == "release" ]]; }

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
  set_env TAXTRONIK_DEPLOY_CHANNEL "$(deployment_channel)"
  set_env TAXTRONIK_IMAGE_PREFIX "${TAXTRONIK_IMAGE_PREFIX:-taxtronik}"
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
    die "TAXTRONIK_VERSION fehlt. './taxtronik deploy' setzt sie passend zum gewaehlten Bezugsweg."
  if images_from_registry; then
    [[ "${TAXTRONIK_IMAGE_PREFIX:-}" == */* ]] || \
      die "Release-Kanal braucht TAXTRONIK_IMAGE_PREFIX=<registry>/<projekt>."
    [[ "$TAXTRONIK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
      die "Release-Kanal akzeptiert nur eine veroeffentlichte SemVer X.Y.Z (aktuell: $TAXTRONIK_VERSION)."
  else
    [[ "$TAXTRONIK_VERSION" =~ ^source-[0-9a-f]{12}$ ]] || \
      die "Source-Kanal braucht die automatisch erzeugte Kennung source-<Git-Commit> (aktuell: $TAXTRONIK_VERSION)."
  fi
}

assert_production_env() {
  [[ "${NODE_ENV:-production}" == "production" ]] || \
    die "NODE_ENV muss fuer Operator-Skripte 'production' sein (aktuell: ${NODE_ENV:-unset}). Server nutzt ./taxtronik deploy, nicht scripts/setup.sh."
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
  local fix=0 deploy_channel=""
  [[ "${1:-}" == "--fix" ]] && fix=1

  [[ -f "$ENVFILE" ]] || { echo "FEHLER: $ENVFILE fehlt. Prod: ./taxtronik deploy" >&2; return 1; }

  if [[ $fix -eq 1 ]]; then
    info "doctor --fix: Secrets + Prod-Defaults ergaenzen"
    deploy_channel="$(deployment_channel 2>/dev/null || true)"
    if [[ "$deploy_channel" == "source" ]]; then
      set_env TAXTRONIK_DEPLOY_CHANNEL source
      set_env TAXTRONIK_IMAGE_PREFIX taxtronik
      set_env TAXTRONIK_VERSION "$(source_version_for_checkout)"
    elif [[ "$deploy_channel" == "release" ]]; then
      set_env TAXTRONIK_DEPLOY_CHANNEL release
    fi
    [[ "$(get_env NODE_ENV)" != "production" ]] && { set_env NODE_ENV production; info "NODE_ENV=production gesetzt."; }
    [[ -z "$(get_env TIMESTAMP_AUTHORITY_URL)" ]] && { set_env TIMESTAMP_AUTHORITY_URL "http://timestamp.globalsign.com/tsa/r6advanced1"; info "TIMESTAMP_AUTHORITY_URL=GlobalSign gesetzt."; }
    # Host-/Proxy-Trust nie erraten. Der sichere Default ignoriert Forwarded-
    # Header; ein korrekt konfigurierter Reverse-Proxy ist bewusstes Opt-in.
    [[ -z "$(get_env NEXTAUTH_TRUST_HOST)" ]] && { set_env NEXTAUTH_TRUST_HOST true; info "NEXTAUTH_TRUST_HOST=true gesetzt (Auth.js-Pflicht; Proxy muss Host pinnen)."; }
    [[ -z "$(get_env TRUST_PROXY_REQUIRED)" ]] && { set_env TRUST_PROXY_REQUIRED false; info "TRUST_PROXY_REQUIRED=false gesetzt (sicherer Default)."; }
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
  if [[ -z "${SECRET_BOX_KEY:-}" ]]; then
    _dr_row "WARN" "SECRET_BOX_KEY" "Legacy-Fallback auf AUTH_SECRET; vor Produktivdaten separat provisionieren"
    _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_secret SECRET_BOX_KEY 32
  fi
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

  deploy_channel="$(deployment_channel 2>/dev/null || true)"
  if [[ "$deploy_channel" == "source" ]]; then
    _dr_row "OK" "TAXTRONIK_DEPLOY_CHANNEL" "source (aktueller Git-Stand, lokaler Build)"
    if [[ "${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" == */* ]]; then
      _dr_row "FEHLT" "TAXTRONIK_IMAGE_PREFIX" "Source-Kanal darf keinen Registry-Prefix verwenden"
      _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
    if [[ "${TAXTRONIK_VERSION:-}" =~ ^source-[0-9a-f]{12}$ ]]; then
      _dr_row "OK" "TAXTRONIK_VERSION" "$TAXTRONIK_VERSION"
    else
      _dr_row "FEHLT" "TAXTRONIK_VERSION" "Source-Kennung fehlt; ./taxtronik deploy setzt sie automatisch"
      _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
  elif [[ "$deploy_channel" == "release" ]]; then
    _dr_row "OK" "TAXTRONIK_DEPLOY_CHANNEL" "release (signierte Registry-Artefakte)"
    if [[ "${TAXTRONIK_IMAGE_PREFIX:-}" != */* ]]; then
      _dr_row "FEHLT" "TAXTRONIK_IMAGE_PREFIX" "Release-Kanal braucht <registry>/<projekt>"
      _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
    if [[ "${TAXTRONIK_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      _dr_row "OK" "TAXTRONIK_VERSION" "$TAXTRONIK_VERSION"
    else
      _dr_row "FEHLT" "TAXTRONIK_VERSION" "exakter Tag eines veroeffentlichten Releases X.Y.Z fehlt"
      _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
  else
    _dr_row "FEHLT" "TAXTRONIK_DEPLOY_CHANNEL" "muss source oder release sein"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  fi

  local deploy_method="" traefik_staff_host="" traefik_portal_host="" traefik_n8n_host=""
  deploy_method="$(deployment_method 2>/dev/null || true)"
  if [[ "$deploy_method" == "standard" ]]; then
    _dr_row "OK" "DEPLOYMENT_METHOD" "standard (vorhandener/externer Reverse-Proxy)"
  elif [[ "$deploy_method" == "traefik" ]]; then
    traefik_staff_host="$(url_hostname "${NEXTAUTH_URL:-}")"
    traefik_portal_host="$(url_hostname "${PORTAL_PUBLIC_URL:-}")"
    traefik_n8n_host="${N8N_HOST:-}"
    if [[ "${NEXTAUTH_URL:-}" != https://* || "${PORTAL_PUBLIC_URL:-}" != https://* || \
          "${N8N_WEBHOOK_URL:-}" != "https://${traefik_n8n_host}/" || "${N8N_PROXY_HOPS:-}" != "1" || \
          -z "$traefik_staff_host" || -z "$traefik_portal_host" || \
          ! "$traefik_n8n_host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ || \
          "$traefik_staff_host" == "$traefik_portal_host" || \
          "$traefik_staff_host" == "$traefik_n8n_host" || \
          "$traefik_portal_host" == "$traefik_n8n_host" ]]; then
      _dr_row "FEHLT" "TRAEFIK_SURFACES" "getrennte HTTPS-Domains fuer Kanzlei, Mandanten und n8n erforderlich"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "DEPLOYMENT_METHOD" "traefik (verwaltetes HTTPS)"
    fi
    if ! valid_setup_email "${TRAEFIK_ACME_EMAIL:-}"; then
      _dr_row "FEHLT" "TRAEFIK_ACME_EMAIL" "ungueltig/leer"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "TRAEFIK_ACME_EMAIL" "$TRAEFIK_ACME_EMAIL"
    fi
  else
    _dr_row "FEHLT" "DEPLOYMENT_METHOD" "nur standard oder traefik erlaubt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  fi

  if [[ -z "${NEXTAUTH_URL:-}" ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "leer"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ "$NEXTAUTH_URL" == *localhost* || "$NEXTAUTH_URL" == *127.0.0.1* ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "=$NEXTAUTH_URL (oeffentliche URL setzen)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else _dr_row "OK" "NEXTAUTH_URL" "$NEXTAUTH_URL"; fi

  local public_n8n_host="${N8N_HOST:-}" public_staff_host public_portal_host
  public_staff_host="$(url_hostname "${NEXTAUTH_URL:-}")"
  public_portal_host="$(url_hostname "${PORTAL_PUBLIC_URL:-}")"
  public_n8n_host="${public_n8n_host,,}"
  if ! valid_public_fqdn "$public_n8n_host" || \
     [[ "${N8N_WEBHOOK_URL:-}" != "https://${public_n8n_host}/" || \
        ! "${N8N_PROXY_HOPS:-}" =~ ^[1-9][0-9]*$ || \
        "$public_n8n_host" == "${public_staff_host,,}" || \
        "$public_n8n_host" == "${public_portal_host,,}" ]]; then
    _dr_row "FEHLT" "N8N_PUBLIC_URL" "eigene HTTPS-Domain + N8N_PROXY_HOPS erforderlich"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "N8N_PUBLIC_URL" "$N8N_WEBHOOK_URL"
  fi

  # Auth.js v5 blockiert bei false jede Anfrage. Production braucht true und
  # einen Reverse-Proxy, der Host/X-Forwarded-Host kanonisch setzt.
  if [[ "${NODE_ENV:-}" == "production" && "${NEXTAUTH_TRUST_HOST:-}" != "true" ]]; then
    _dr_row "FEHLT" "NEXTAUTH_TRUST_HOST" "in Prod exakt true; Proxy muss Host pinnen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else _dr_row "OK" "NEXTAUTH_TRUST_HOST" "${NEXTAUTH_TRUST_HOST:-true}"; fi

  if [[ "$deploy_method" == "traefik" && "${TRUST_PROXY_REQUIRED:-}" != "true" ]]; then
    _dr_row "FEHLT" "TRUST_PROXY_REQUIRED" "Traefik-Pfad braucht exakt true"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "${TRUST_PROXY_REQUIRED:-}" != "true" && "${TRUST_PROXY_REQUIRED:-}" != "false" ]]; then
    _dr_row "FEHLT" "TRUST_PROXY_REQUIRED" "explizit true/false setzen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else _dr_row "OK" "TRUST_PROXY_REQUIRED" "$TRUST_PROXY_REQUIRED"; fi

  # Risk-Layer (optional): URL und Basis-Token MÜSSEN als Paar gesetzt werden.
  # Das getrennte Operator-Token aktiviert schreibende Betriebsfunktionen. Bei
  # bestehenden Installationen bleibt ein fehlendes Operator-Token eine
  # Warnung; ein gesetzter, aber ungueltiger Wert muss den Start blockieren.
  local rl_url="${RISK_LAYER_URL:-}" rl_tok="${RISK_LAYER_TOKEN:-}"
  local rl_operator_tok="${RISK_LAYER_OPERATOR_TOKEN:-}"
  local rl_festwissen="${RISK_LAYER_FESTWISSEN_DIR:-}"
  local signal_mode=""
  local resolved_signal_image=""
  local signal_channel="" signal_git_url="" signal_git_ref="" signal_git_dir=""
  signal_mode="$(signal_deployment_mode 2>/dev/null || true)"
  if [[ -z "$signal_mode" ]]; then
    _dr_row "FEHLT" "SIGNAL_DEPLOYMENT" "nur managed, external oder disabled erlaubt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$signal_mode" == "disabled" ]]; then
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "disabled"
    if [[ -n "$rl_url$rl_tok$rl_operator_tok" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_URL/TOKEN" "bei disabled muessen Signal-Werte leer sein"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "SIGNAL" "deaktiviert"
    fi
  elif [[ "$signal_mode" == "managed" ]]; then
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "managed"
    [[ "${rl_url%/}" == "http://risk-layer:8000" ]] || {
      _dr_row "FEHLT" "RISK_LAYER_URL" "verwaltetes Signal muss http://risk-layer:8000 verwenden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    }
    if (( ${#rl_tok} < 32 )); then
      _dr_row "FEHLT" "RISK_LAYER_TOKEN" "nur ${#rl_tok} Zeichen (< 32)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "SIGNAL" "verwaltet (URL + Bearer-Token)"
    fi
    if [[ -z "$rl_operator_tok" ]]; then
      _dr_row "WARN" "RISK_LAYER_OPERATOR_TOKEN" "fehlt; Embedding-Steuerung bleibt read-only"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    elif (( ${#rl_operator_tok} < 32 )); then
      _dr_row "FEHLT" "RISK_LAYER_OPERATOR_TOKEN" "nur ${#rl_operator_tok} Zeichen (< 32)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    elif [[ "$rl_operator_tok" == "$rl_tok" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_OPERATOR_TOKEN" "muss sich vom Bearer-Token unterscheiden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER_OPERATOR_TOKEN" "konfiguriert"
    fi
    signal_channel="$(signal_deploy_channel 2>/dev/null || true)"
    if [[ "$signal_channel" == "source" ]]; then
      signal_git_url="${SIGNAL_GIT_URL:-$SIGNAL_GIT_URL_DEFAULT}"
      signal_git_ref="${SIGNAL_GIT_REF:-$SIGNAL_GIT_REF_DEFAULT}"
      signal_git_dir="$(signal_source_dir)"
      if ! valid_signal_git_url "$signal_git_url"; then
        _dr_row "FEHLT" "SIGNAL_GIT_URL" "nur HTTPS- oder SSH-Git-URL erlaubt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      elif ! valid_signal_git_ref "$signal_git_ref"; then
        _dr_row "FEHLT" "SIGNAL_GIT_REF" "ungueltiger Branch, Tag oder Commit"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      elif [[ "$signal_git_dir" != /* || "$signal_git_dir" == "/" || \
              "$signal_git_dir" == "$ROOT" || "$signal_git_dir" == "$ROOT/"* ]]; then
        _dr_row "FEHLT" "SIGNAL_GIT_DIR" "absoluter eigener Checkout-Pfad erforderlich"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      else
        _dr_row "OK" "SIGNAL_SOURCE" "$signal_git_url @ $signal_git_ref"
      fi
    elif [[ "$signal_channel" == "image" ]]; then
      resolved_signal_image="$(signal_managed_image)"
      if validate_signal_managed_image "$resolved_signal_image"; then
        _dr_row "OK" "SIGNAL_IMAGE" "$resolved_signal_image"
      else
        _dr_row "FEHLT" "SIGNAL_IMAGE" "versionierten vX.Y.Z-Tag oder sha256-Digest setzen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      fi
    else
      _dr_row "FEHLT" "SIGNAL_DEPLOY_CHANNEL" "nur source oder image erlaubt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
    if [[ "${RISK_LAYER_EMB_DEVICE:-cpu}" != "cpu" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_EMB_DEVICE" "verwaltetes Release ist CPU; GPU-Signal als external anbinden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER_EMB_DEVICE" "cpu"
    fi
    if [[ -n "$rl_festwissen" ]]; then
      _dr_row "WARN" "RISK_LAYER_FESTWISSEN_DIR" "wird im verwalteten Self-contained-Image nicht mehr verwendet"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    fi
  elif [[ "$signal_mode" == "external" && -z "$rl_url" ]]; then
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "external"
    _dr_row "FEHLT" "RISK_LAYER_URL" "externes Signal braucht eine erreichbare URL"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -n "$rl_url" && -z "$rl_tok" ]]; then
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "external"
    _dr_row "FEHLT" "RISK_LAYER_TOKEN" "URL gesetzt, Token fehlt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -z "$rl_url" && -n "$rl_tok" ]]; then
    _dr_row "FEHLT" "RISK_LAYER_URL" "Token gesetzt, URL fehlt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -n "$rl_url" ]]; then
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "external"
    if [[ ${#rl_tok} -lt 32 ]]; then
      _dr_row "FEHLT" "RISK_LAYER_TOKEN" "nur ${#rl_tok} Zeichen (< 32)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER" "konfiguriert (URL + Token)"
    fi
    if [[ -z "$rl_operator_tok" ]]; then
      _dr_row "WARN" "RISK_LAYER_OPERATOR_TOKEN" "fehlt; Embedding-Steuerung bleibt read-only"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    elif [[ ${#rl_operator_tok} -lt 32 ]]; then
      _dr_row "FEHLT" "RISK_LAYER_OPERATOR_TOKEN" "nur ${#rl_operator_tok} Zeichen (< 32)"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    elif [[ "$rl_operator_tok" == "$rl_tok" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_OPERATOR_TOKEN" "muss sich vom Bearer-Token unterscheiden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER_OPERATOR_TOKEN" "konfiguriert"
    fi
    if [[ "${rl_url%/}" == "http://risk-layer:8000" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_URL" "Compose-DNS gehoert zum verwalteten Modus"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
    _dr_row "OK" "SIGNAL_UPDATE" "extern verwaltet; TaxTronik aktualisiert Signal nicht"
  elif [[ -n "$rl_operator_tok" ]]; then
    _dr_row "FEHLT" "RISK_LAYER_URL/TOKEN" "Operator-Token ohne Basiskonfiguration"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "RISK_LAYER" "inaktiv (ok)"
  fi

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
build_memory_to_kib() {
  local value="${1,,}"
  if [[ "$value" =~ ^([1-9][0-9]*)m$ ]]; then
    printf '%s\n' "$((10#${BASH_REMATCH[1]} * 1024))"
  elif [[ "$value" =~ ^([1-9][0-9]*)g$ ]]; then
    printf '%s\n' "$((10#${BASH_REMATCH[1]} * 1024 * 1024))"
  else
    return 1
  fi
}

host_available_memory_kib() {
  [[ -r /proc/meminfo ]] || return 1
  awk '$1 == "MemAvailable:" { print $2; exit }' /proc/meminfo
}

require_safe_build_resources() {
  local limit="$1" reserve="$2" limit_kib reserve_kib available_kib required_kib build_help

  limit_kib="$(build_memory_to_kib "$limit")" || \
    die "TAXTRONIK_BUILD_MEMORY_LIMIT muss z. B. 3072m oder 3g sein (aktuell: $limit)."
  reserve_kib="$(build_memory_to_kib "$reserve")" || \
    die "TAXTRONIK_BUILD_MEMORY_RESERVE muss z. B. 1024m oder 1g sein (aktuell: $reserve)."

  # Ein V8-Heap-Limit schuetzt den Host nicht: Next/Turbopack startet weitere
  # Prozesse und belegt nativen Speicher ausserhalb des JavaScript-Heaps. Nur
  # ein cgroup-Limit fuer den gesamten Build-RUN-Schritt verhindert, dass der
  # Docker-Daemon den Host bis zur Handlungsunfaehigkeit ins Swapping treibt.
  build_help="$(docker build --help 2>&1)" || \
    die "Docker-Build-Hilfe konnte nicht abgefragt werden."
  grep -Fq -- '--resource' <<<"$build_help" || \
    die "Docker/Buildx unterstuetzt noch kein --resource. Sicherer Lokalbuild verweigert: Docker/Buildx aktualisieren oder TAXTRONIK_IMAGE_PREFIX auf die Release-Registry setzen."

  if available_kib="$(host_available_memory_kib 2>/dev/null)" && \
      [[ "$available_kib" =~ ^[0-9]+$ ]]; then
    required_kib=$((limit_kib + reserve_kib))
    (( available_kib >= required_kib )) || \
      die "Lokalbuild wegen RAM-Schutz abgebrochen: verfuegbar $((available_kib / 1024)) MiB, erforderlich $((required_kib / 1024)) MiB ($limit Build-Limit + $reserve Systemreserve). Dienste im Wartungsfenster stoppen oder Registry-Images verwenden."
    info "RAM-Schutz: Build maximal $limit ohne Swap; $reserve Systemreserve (verfuegbar: $((available_kib / 1024)) MiB)."
  else
    warn "Freier Host-RAM konnte nicht aus /proc/meminfo ermittelt werden; das harte Docker-Limit $limit ohne Build-Swap bleibt aktiv."
  fi
}

build_images() {
  local prefix tag sha memory_limit memory_reserve
  prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}"
  tag="$(image_tag)"
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  memory_limit="${TAXTRONIK_BUILD_MEMORY_LIMIT:-3g}"
  memory_limit="${memory_limit,,}"
  memory_reserve="${TAXTRONIK_BUILD_MEMORY_RESERVE:-1g}"
  memory_reserve="${memory_reserve,,}"
  export DOCKER_BUILDKIT=1   # BuildKit aktivieren fuer --mount=type=cache (Dockerfile.web/.worker)

  require_safe_build_resources "$memory_limit" "$memory_reserve"

  # Build-Lock: BuildKit-Builds laufen im Docker-DAEMON weiter, wenn der
  # Client stirbt (SSH-Abbruch, hartes CTRL+C). Ein neu gestarteter Updater
  # verkeilte sich dann still mit dem verwaisten Build. Der flock macht daraus
  # eine klare Meldung; laeuft der verwaiste Build im Daemon noch, teilt der
  # neue Build dank BuildKit-Dedupe dessen Fortschritt statt doppelt zu bauen.
  if command -v flock >/dev/null 2>&1; then
    exec 8>"$ROOT/.taxtronik.build.lock"
    if ! flock -n 8; then
      info "Ein anderer Image-Build laeuft bereits (z. B. abgebrochene Session) — warte auf dessen Ende ..."
      flock 8
    fi
  fi

  info "Docker-Images bauen: $prefix/web:$tag und $prefix/worker:$tag"
  info "Hinweis: next build/tsc sind die laengsten Schritte (mehrere Minuten ohne warmen Cache)."
  docker build --resource "memory=$memory_limit" --resource "memory-swap=$memory_limit" \
    -f "$ROOT/infra/docker/Dockerfile.web" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/web:$tag" "$ROOT"
  docker build --resource "memory=$memory_limit" --resource "memory-swap=$memory_limit" \
    -f "$ROOT/infra/docker/Dockerfile.worker" \
    --build-arg APP_VERSION="$tag" --build-arg GIT_SHA="$sha" \
    -t "$prefix/worker:$tag" "$ROOT"
  prune_build_cache
  if command -v flock >/dev/null 2>&1; then flock -u 8 || true; fi
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

provide_traefik_for_deploy() {
  [[ "$(deployment_method)" == "traefik" ]] || return 0
  info "Digest-gepinntes Traefik-Image beziehen"
  compose pull traefik || die "Traefik-Image konnte nicht bezogen werden."
}

signal_rebuild_prompt_available() {
  [[ -t 0 && -t 1 ]]
}

signal_rebuild_unchanged_requested() {
  local operation="$1" sha="$2" answer="" force="${SIGNAL_FORCE_REBUILD:-}"
  case "${force,,}" in
    1|true|yes|ja)
      info "SIGNAL_FORCE_REBUILD ist aktiv - Signal wird trotz identischem Commit neu gebaut."
      return 0
      ;;
    0|false|no|nein)
      return 1
      ;;
    '') ;;
    *) die "SIGNAL_FORCE_REBUILD muss 1/true/yes/ja oder 0/false/no/nein sein." ;;
  esac

  [[ "$operation" == "update" ]] || return 1
  if signal_rebuild_prompt_available; then
    read -rp "Signal ist bereits auf Commit ${sha:0:12}. Trotzdem neu bauen? [j/N]: " answer || true
    case "${answer,,}" in
      j|ja|y|yes) return 0 ;;
      *) return 1 ;;
    esac
  fi

  info "Signal unveraendert - Neuaufbau wird im unbeaufsichtigten Update uebersprungen (SIGNAL_FORCE_REBUILD=1 erzwingt ihn)."
  return 1
}

build_signal_from_source() {
  local operation="${1:-deploy}"
  local url ref dir parent origin status sha target configured_image memory_limit memory_reserve cpus newly_cloned=0
  url="${SIGNAL_GIT_URL:-$SIGNAL_GIT_URL_DEFAULT}"
  ref="${SIGNAL_GIT_REF:-$SIGNAL_GIT_REF_DEFAULT}"
  dir="$(signal_source_dir)"
  memory_limit="${SIGNAL_BUILD_MEMORY_LIMIT:-3g}"
  memory_reserve="${SIGNAL_BUILD_MEMORY_RESERVE:-1g}"
  cpus="${SIGNAL_BUILD_CPUS:-2}"

  valid_signal_git_url "$url" || die "SIGNAL_GIT_URL muss eine HTTPS- oder SSH-Git-URL ohne eingebettete Zugangsdaten sein."
  valid_signal_git_ref "$ref" || die "SIGNAL_GIT_REF ist ungueltig. Branch, Tag oder Commit ohne Shell-Sonderzeichen angeben."
  [[ "$dir" == /* && "$dir" != "/" && "$dir" != "$ROOT" && "$dir" != "$ROOT/"* ]] || \
    die "SIGNAL_GIT_DIR muss ein absoluter eigener Checkout-Pfad ausserhalb des TaxTronik-Repos sein."
  [[ "$cpus" =~ ^[1-9][0-9]?$ ]] || die "SIGNAL_BUILD_CPUS muss eine ganze Zahl zwischen 1 und 99 sein."
  require_safe_build_resources "$memory_limit" "$memory_reserve"

  if [[ ! -e "$dir" ]]; then
    parent="$(dirname "$dir")"
    mkdir -p "$parent" || die "Signal-Checkout-Elternpfad konnte nicht angelegt werden: $parent"
    info "Signal-Quellstand klonen: $url -> $dir"
    (umask 022; git clone --no-checkout "$url" "$dir") || \
      die "Signal-Git-Repository konnte nicht geklont werden."
    newly_cloned=1
  fi
  [[ -d "$dir/.git" ]] || die "SIGNAL_GIT_DIR ist kein von TaxTronik nutzbarer Git-Checkout: $dir"
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "$url" ]] || \
    die "Signal-Checkout hat einen anderen origin ($origin). Erwartet: $url"
  # Ein aelterer TaxTronik-Lauf kann nach `clone --no-checkout` genau mit
  # einem leeren Arbeitsbaum und dem vollstaendigen .git-Verzeichnis beendet
  # worden sein. Solange wirklich kein einziges Arbeitsbaumobjekt existiert,
  # kann der kontrollierte Initial-Checkout gefahrlos nachgeholt werden.
  if (( newly_cloned == 0 )) && \
     [[ -z "$(find "$dir" -mindepth 1 -maxdepth 1 ! -name .git -print -quit 2>/dev/null)" ]]; then
    newly_cloned=1
  fi
  if (( newly_cloned == 0 )); then
    status="$(git -C "$dir" status --porcelain --untracked-files=normal 2>/dev/null || true)"
    [[ -z "$status" ]] || \
      die "Signal-Checkout enthaelt lokale Aenderungen. TaxTronik ueberschreibt sie nicht; bereinigen oder SIGNAL_GIT_DIR wechseln."
  fi

  info "Signal-Git-Ref beziehen: $ref"
  (umask 022; git -C "$dir" fetch --prune origin "$ref") || \
    die "Signal-Git-Ref konnte nicht bezogen werden: $ref"
  sha="$(git -C "$dir" rev-parse --verify FETCH_HEAD 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "Signal-Git-Ref wurde nicht zu einem eindeutigen Commit aufgeloest."
  (umask 022; git -C "$dir" checkout --detach "$sha") || \
    die "Signal-Checkout konnte nicht auf $sha gesetzt werden."
  status="$(git -C "$dir" status --porcelain --untracked-files=normal 2>/dev/null || true)"
  [[ -z "$status" ]] || \
    die "Signal-Checkout ist nach dem kontrollierten Checkout nicht sauber; Build wird verweigert."
  [[ -f "$dir/scripts/build-managed-image.sh" ]] || \
    die "Signal-Quellstand unterstuetzt den verwalteten Source-Build noch nicht (scripts/build-managed-image.sh fehlt)."

  target="taxtronik/risk-layer-engine:source-${sha:0:12}"
  configured_image="${SIGNAL_IMAGE:-$(get_env SIGNAL_IMAGE)}"
  export SIGNAL_IMAGE="$target"

  # Der Commit ist bereits Teil des unveraenderlichen lokalen Image-Tags. Ein
  # vorhandenes Ziel-Image beweist daher, dass genau dieser Signal-Stand schon
  # erfolgreich gebaut wurde. Bei einem echten Quell-Update wird ein eventuell
  # bereits vorbereitetes Image wiederverwendet; nur beim identischen, bereits
  # aktiven Stand bieten wir einen bewussten Rebuild an.
  if docker image inspect "$target" >/dev/null 2>&1; then
    if [[ "$configured_image" == "$target" ]]; then
      info "Signal-Quellstand unveraendert: Commit ${sha:0:12}, lokales Image vorhanden."
      if ! signal_rebuild_unchanged_requested "$operation" "$sha"; then
        info "Signal-Build uebersprungen; vorhandenes Image wird weiterverwendet."
        return 0
      fi
    else
      info "Signal-Image fuer neuen Quellstand ${sha:0:12} ist bereits lokal vorhanden; Build wird uebersprungen."
      return 0
    fi
  elif [[ "$configured_image" == "$target" ]]; then
    warn "Signal-Commit ist unveraendert, aber das zugehoerige lokale Image fehlt - Neuaufbau erforderlich."
  else
    info "Neuer Signal-Quellstand erkannt: ${sha:0:12} - Image wird gebaut."
  fi

  if command -v flock >/dev/null 2>&1; then
    exec 7>"$ROOT/.taxtronik.signal-build.lock"
    if ! flock -n 7; then
      info "Ein anderer Signal-Build laeuft bereits - warte auf dessen Ende ..."
      flock 7
    fi
  fi
  info "Signal aus Git-Commit ${sha:0:12} lokal bauen (mit Quanten-Extras, kein automatischer Embedding-Index)"
  SIGNAL_BUILD_MEMORY_LIMIT="$memory_limit" SIGNAL_BUILD_CPUS="$cpus" \
    sh "$dir/scripts/build-managed-image.sh" "$target" || \
    die "Signal-Source-Build fehlgeschlagen; laufender Container bleibt unveraendert."
  if command -v flock >/dev/null 2>&1; then flock -u 7 || true; fi
}

verify_signal_managed_image() {
  local image="$1" channel="$2" check
  check="import importlib.util,pathlib,sys; required=['/release/catalog/begriffe.yaml','/release/corpus/graph.sqlite','/release/models/bge-m3/model-manifest.json']; index=['/release/corpus/embedding/meta.json','/release/corpus/embedding/vectors.npy']; modules=['sentence_transformers','qiskit','qiskit_aer','qiskit_ibm_runtime']; core=all(pathlib.Path(p).is_file() for p in required) and all(importlib.util.find_spec(m) is not None for m in modules); complete_index=all(pathlib.Path(p).is_file() for p in index); sys.exit(0 if core and ('$channel' == 'source' or complete_index) else 1)"
  docker run --rm --entrypoint python "$image" -c "$check" || \
    die "Signal-Image ist kein vollstaendiger Managed-Stand (Graph, Offline-Modell, Embedding- oder Quanten-Runtime fehlt)."
}

provide_signal_for_deploy() {
  local operation="${1:-deploy}" mode image channel
  mode="$(signal_deployment_mode)"
  case "$mode" in
    disabled)
      info "Signal deaktiviert - kein Image-Pull"
      return 0
      ;;
    external)
      info "Signal extern verwaltet - TaxTronik ueberspringt Installation und Update"
      return 0
      ;;
    managed) ;;
    *) die "Unbekannter Signal-Betriebsmodus: $mode" ;;
  esac

  channel="$(signal_deploy_channel)" || die "SIGNAL_DEPLOY_CHANNEL muss source oder image sein."
  if [[ "$channel" == "source" ]]; then
    build_signal_from_source "$operation"
    image="$SIGNAL_IMAGE"
  else
    prepare_signal_managed_environment
    image="$SIGNAL_IMAGE"
    info "Verwaltetes Signal-Image beziehen: $image"
    if ! compose --profile risk-layer pull risk-layer; then
      die "Signal-Image konnte nicht bezogen werden. Registry-Zugang pruefen oder SIGNAL_DEPLOY_CHANNEL=source waehlen."
    fi
  fi
  # Das verwaltete Release muss vollstaendig self-contained sein. Dadurch wird
  # ein altes Runtime-only-Image vor dem Austausch des laufenden Dienstes
  # erkannt und der bisherige Container bleibt unangetastet.
  verify_signal_managed_image "$image" "$channel"
}

start_signal_for_deploy() {
  [[ "$(signal_deployment_mode)" == "managed" ]] || return 0
  prepare_signal_managed_environment
  local previous_image=""
  previous_image="$(docker inspect --format '{{.Config.Image}}' taxtronik-risk-layer 2>/dev/null || true)"
  info "Verwaltetes Signal starten und API-/Embedding-Readiness pruefen"
  if compose --profile risk-layer up -d --force-recreate --no-deps \
      --wait --wait-timeout 300 risk-layer; then
    if [[ "$(signal_deploy_channel)" == "source" ]]; then
      set_env SIGNAL_IMAGE "$SIGNAL_IMAGE"
    fi
    return 0
  fi

  warn "Neues Signal-Release wurde nicht bereit; versuche den vorherigen Containerstand wiederherzustellen."
  if [[ -n "$previous_image" && "$previous_image" != "$SIGNAL_IMAGE" ]]; then
    export SIGNAL_IMAGE="$previous_image"
    compose --profile risk-layer up -d --force-recreate --no-deps \
      --wait --wait-timeout 300 risk-layer \
      || warn "Auch der vorherige Signal-Container konnte nicht wiederhergestellt werden."
  fi
  return 1
}

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
  begin_migration_transition
  info "DB-Migrationen anwenden (migrate-Container)"
  compose run --rm migrate
  database_has_gwg_invariants_for_checkout || \
    die "DB-Migrationen sind journalisiert, aber der GwG-Datenbankschutz ist unvollstaendig; neue Writer werden nicht aktiviert."
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
  assert_writer_start_authorized
  local services=(app worker n8n)
  if [[ "$(deployment_method)" == "traefik" ]]; then
    services+=(traefik)
    info "App, Worker, n8n und verwaltetes Traefik starten/neu erzeugen"
  else
    info "App, Worker und n8n starten/neu erzeugen"
  fi
  run_backup_dir_init
  compose up -d --force-recreate --no-deps "${services[@]}"
}

# Bash-`local` ist dynamisch sichtbar: start_apps und der darin aufgerufene
# Compose-Wrapper sehen diese Werte, ohne dass eine vom Operator setzbare
# Umgebungsvariable exportiert werden muss.
start_apps_for_activation() {
  local _TAXTRONIK_INTERNAL_WRITER_START_REASON="${1:-}"
  local _TAXTRONIK_INTERNAL_WRITER_START_TARGET="${2:-}"
  [[ -n "$_TAXTRONIK_INTERNAL_WRITER_START_REASON" && \
     -n "$_TAXTRONIK_INTERNAL_WRITER_START_TARGET" ]] || \
    die "Interne Writer-Aktivierung braucht Grund und Zielversion."
  start_apps
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

smoke_public_frontend() {
  [[ "$(deployment_method)" == "traefik" ]] || return 0
  local staff_url="${NEXTAUTH_URL%/}/api/health"
  local portal_url="${PORTAL_PUBLIC_URL%/}/api/health"
  local n8n_url="https://${N8N_HOST}/healthz"
  info "Oeffentlichen Traefik-/TLS-Einstieg pruefen"
  for _ in {1..36}; do
    if curl -fsS --max-time 10 -o /dev/null "$staff_url" 2>/dev/null && \
       curl -fsS --max-time 10 -o /dev/null "$portal_url" 2>/dev/null && \
       curl -fsS --max-time 10 -o /dev/null "$n8n_url" 2>/dev/null; then
      info "Kanzleiportal, Mandantenportal und n8n sind per HTTPS bereit."
      return 0
    fi
    sleep 5
  done
  compose logs traefik --tail 100 || true
  warn "Oeffentlicher HTTPS-Smoke fehlgeschlagen. DNS, Provider-Firewall sowie Ports 80/443 pruefen."
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
  if ! database_has_gwg_invariants_for_checkout; then
    warn "Deploy-Readiness fehlgeschlagen: GwG-Datenbankschutz entspricht nicht dem Migrationsstand dieses Checkouts."
    return 1
  fi
  s3_hp="$(docker port taxtronik-seaweedfs 8333 2>/dev/null | head -n1 || true)"
  clam_hp="$(docker port taxtronik-clamav 3310 2>/dev/null | head -n1 || true)"
  if [[ -z "$s3_hp" || -z "$clam_hp" ]]; then
    warn "Deploy-Readiness fehlgeschlagen: SeaweedFS/ClamAV-Hostports nicht ermittelbar."
    return 1
  fi
  s3_endpoint="http://${s3_hp/0.0.0.0/127.0.0.1}"
  clam_host="${clam_hp%%:*}"; clam_host="${clam_host/0.0.0.0/127.0.0.1}"
  clam_port="${clam_hp##*:}"

  # Nach einem Update/Rollback koennen die Host-node_modules noch zum alten
  # Checkout gehoeren. Vor dem Retry-Loop synchronisieren, damit ein pnpm-
  # Workspace-Fehler nicht viermal faelschlich als ClamAV-Wartezeit erscheint.
  ensure_host_tool_deps

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

host_tool_deps_current() {
  host_tool_deps_ready || return 1
  # `verifyDepsBeforeRun: error` schuetzt vor veralteten injected Workspace-
  # Snapshots. Ein Checkout-Wechsel kann package.json-Dateien aendern, obwohl
  # Prisma/tsx noch vorhanden sind; die reine Existenzpruefung reicht dann
  # nicht. Der harmlose pnpm-Probe-Run nutzt exakt denselben Guard wie die
  # anschliessenden Host-Kommandos, erzeugt aber keine Seiteneffekte.
  ( cd "$ROOT" && pnpm --filter @taxtronik/storage exec node -e 'process.exit(0)' ) \
    >/dev/null 2>&1
}

ensure_host_tool_deps() {
  host_tool_deps_current && return 0
  require_cmd pnpm
  info "Host-Tool-Abhaengigkeiten mit aktuellem Checkout synchronisieren (Prisma/tsx/Readiness)"
  # NODE_ENV=production laesst pnpm devDependencies sonst aus. Die Host-Tools
  # laufen zwar auf einem Prod-Server, brauchen aber Prisma CLI + tsx aus den
  # workspace-devDependencies. Der Install-Lauf aktualisiert zugleich pnpm's
  # injected Workspace-Snapshots nach einem git-Checkout-Wechsel. Runtime
  # bleibt trotzdem containerisiert.
  (cd "$ROOT" && pnpm install --frozen-lockfile --prod=false \
    --filter @taxtronik/web... --filter @taxtronik/web --filter @taxtronik/db)
  host_tool_deps_current || \
    die "Host-Tool-Abhaengigkeiten sind nach pnpm install nicht mit dem Checkout synchron. Bitte pnpm-Install-Log pruefen."
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
  local backup_dir="${1:-}"
  require_cmd pnpm
  info "Backup starten"
  # Der Runner laeuft hier als Host-Prozess, nicht im App-Container. Daher ist
  # dessen Produktionspfad /app/backups ungeeignet. Normale CLI-/Update-Laeufe
  # verwenden den zum Compose-Bind-Mount gehoerenden Host-Pfad; Full-Backups
  # koennen weiterhin ein isoliertes Staging-Verzeichnis explizit uebergeben.
  if [[ -z "$backup_dir" ]]; then
    backup_dir="$(resolve_backup_host_dir)" || return $?
  fi
  mkdir -p "$backup_dir" || {
    warn "Backup-Verzeichnis konnte nicht angelegt werden: $backup_dir"
    return 1
  }
  backup_dir="$(cd "$backup_dir" && pwd -P)" || return $?
  [[ -w "$backup_dir" ]] || {
    warn "Backup-Verzeichnis ist fuer den Operator nicht beschreibbar: $backup_dir"
    return 1
  }
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
  ( cd "$ROOT" && BACKUP_LOCAL_DIR="$backup_dir" pnpm --filter @taxtronik/web backup:run )
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
  local dest="$1" seaweed_volume redis_volume n8n_volume traefik_volume=""
  local snapshot_rc=0 restart_rc=0 method
  seaweed_volume="$(container_named_volume taxtronik-seaweedfs /data)"
  redis_volume="$(container_named_volume taxtronik-redis /data)"
  n8n_volume="$(container_named_volume taxtronik-n8n /home/node/.n8n)"
  method="$(deployment_method)" || return 1
  if [[ "$method" == "traefik" ]]; then
    traefik_volume="$(container_named_volume taxtronik-traefik /letsencrypt)"
  fi
  if [[ -z "$seaweed_volume" || -z "$redis_volume" || -z "$n8n_volume" ]]; then
    warn "Full-Backup kann benoetigte Volumes nicht aufloesen (SeaweedFS/Redis/n8n)."
    restart_backup_infra || true
    return 1
  fi
  if [[ "$method" == "traefik" && -z "$traefik_volume" ]]; then
    warn "Full-Backup kann das Traefik-ACME-Volume nicht aufloesen."
    restart_backup_infra || true
    return 1
  fi

  info "SeaweedFS/Redis fuer konsistenten Volume-Snapshot stoppen (Schreibdienste sind bereits quiesziert)"
  if ! compose --infra stop seaweedfs redis; then
    restart_backup_infra || true
    return 1
  fi
  if [[ "$method" == "traefik" ]]; then
    info "Traefik fuer konsistenten ACME-Snapshot stoppen"
    compose stop traefik || return 1
  fi

  snapshot_named_volume "$seaweed_volume" "$dest" seaweedfs-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$redis_volume" "$dest" redis-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$n8n_volume" "$dest" n8n-data.tar.gz || snapshot_rc=$?
  if [[ "$method" == "traefik" ]]; then
    snapshot_named_volume "$traefik_volume" "$dest" traefik-acme.tar.gz || snapshot_rc=$?
  fi

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

PRODUCTION_RESTORE_CONFIRMATION="RESTORE_TAXTRONIK_PRODUCTION_DATABASE"
RESTORE_LIST_ONLY=0
RESTORE_PRODUCTION_TARGET=0
RESTORE_RELEASE_VERSION=""

# Validiert den Restore-Aufruf VOR jedem start/stop und damit vor jeder
# Seitenauswirkung des Operator-Wrappers. restore.ts prueft dieselben Regeln
# nochmals fuer direkte TypeScript-Aufrufe.
validate_restore_args() {
  local seen=" " option_count=0 source_count=0 target_count=0
  local list_only=0 production_target=0 production_confirmation="" release_version="" arg value

  while (( $# > 0 )); do
    arg="$1"
    case " $seen " in
      *" $arg "*) die "Restore-Option doppelt angegeben: $arg" ;;
    esac

    case "$arg" in
      --list)
        seen+="$arg "; option_count=$((option_count + 1)); list_only=1; shift
        ;;
      --latest)
        seen+="$arg "; option_count=$((option_count + 1)); source_count=$((source_count + 1)); shift
        ;;
      --key|--file)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        seen+="$arg "; option_count=$((option_count + 1)); source_count=$((source_count + 1)); shift 2
        ;;
      --target-url)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        value="$2"
        [[ "$value" == postgres://* || "$value" == postgresql://* ]] || \
          die "--target-url muss mit postgres:// oder postgresql:// beginnen."
        seen+="$arg "; option_count=$((option_count + 1)); target_count=$((target_count + 1)); shift 2
        ;;
      --production-target)
        seen+="$arg "; option_count=$((option_count + 1)); target_count=$((target_count + 1)); production_target=1; shift
        ;;
      --confirm-production-restore)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        production_confirmation="$2"
        seen+="$arg "; option_count=$((option_count + 1)); shift 2
        ;;
      --release-version)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        release_version="$2"
        seen+="$arg "; option_count=$((option_count + 1)); shift 2
        ;;
      --confirm-overwrite|--no-smoke-test)
        seen+="$arg "; option_count=$((option_count + 1)); shift
        ;;
      *)
        die "Unbekannte Restore-Option: $arg"
        ;;
    esac
  done

  if (( list_only == 1 )); then
    (( option_count == 1 )) || die "--list ist read-only und darf nicht mit weiteren Optionen kombiniert werden."
  else
    (( source_count == 1 )) || \
      die "Genau eine Restore-Quelle ist Pflicht: --latest, --key <s3-key> oder --file <pfad>."
    (( target_count == 1 )) || \
      die "Genau ein Restore-Ziel ist Pflicht: --target-url <postgres-url> oder --production-target."
    if (( production_target == 1 )); then
      [[ "$production_confirmation" == "$PRODUCTION_RESTORE_CONFIRMATION" ]] || \
        die "--production-target erfordert die exakte Bestaetigung: --confirm-production-restore $PRODUCTION_RESTORE_CONFIRMATION"
      [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
        die "--production-target erfordert --release-version X.Y.Z passend zum wiederhergestellten Backup."
    else
      [[ -z "$production_confirmation" ]] || \
        die "--confirm-production-restore ist nur zusammen mit --production-target erlaubt."
      [[ -z "$release_version" ]] || \
        die "--release-version ist nur zusammen mit --production-target erlaubt."
    fi
  fi

  RESTORE_LIST_ONLY="$list_only"
  RESTORE_PRODUCTION_TARGET="$production_target"
  RESTORE_RELEASE_VERSION="$release_version"
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
    if [[ "${RESTORE_LIST_ONLY:-0}" == "1" ]]; then
      # --list ist strikt read-only: keine Container starten, keine Credentials
      # neu laden und keine Buckets initialisieren. Ist S3 nicht erreichbar,
      # endet der Aufruf mit einer klaren Betriebsanweisung.
      s3_preflight || die "Read-only Restore-Liste konnte S3 nicht erreichen. Stack zuerst separat starten; --list veraendert keinen Dienstzustand."
    else
      ensure_s3_ready_for_backup
    fi
  fi
  ( cd "$ROOT" && pnpm --filter @taxtronik/web backup:restore -- "$@" )
}

# ---------------------------------------------------------------------------
# Hilfs-Ablaeufe fuer Initial-Deploy / rollback
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

valid_http_url() {
  local value="${1:-}"
  [[ "$value" =~ ^https?://[^[:space:]/]+(:[0-9]+)?(/[^[:space:]]*)?$ ]]
}

assert_blank_host_for_traefik() {
  [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || \
    die "Der 1-Klick-Traefik-Pfad ist nur fuer einen frischen Linux-Host freigegeben."
  [[ ! -e "$STATE" && ! -e "$MIGRATION_PENDING" && ! -e "$DB_RESTORE_AUTHORIZATION" ]] || \
    die "1-Klick verweigert: Auf diesem Checkout existiert bereits Installations-/Recovery-State. Standardmethode verwenden."
  local containers="" docker_data_root="${TAXTRONIK_DOCKER_DATA_ROOT:-/var/lib/docker}"
  if docker_cli_available; then
    if ! containers="$(docker ps -aq 2>/dev/null)"; then
      die "1-Klick verweigert: Docker ist installiert, aber der Daemon nicht erreichbar; Maschinenleerheit kann nicht sicher geprueft werden."
    fi
    [[ -z "$containers" ]] || \
      die "1-Klick verweigert: Docker enthaelt bereits Container. Dieser Pfad ist nur fuer eine komplett leere Maschine; Standardmethode verwenden."
  elif [[ -d "$docker_data_root" && -n "$(find "$docker_data_root" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
    die "1-Klick verweigert: $docker_data_root enthaelt bereits Docker-Daten, obwohl die Docker-CLI fehlt."
  fi
  if one_click_public_ports_in_use; then
    die "1-Klick verweigert: Port 80 oder 443 ist bereits belegt. Standardmethode mit vorhandenem Reverse-Proxy verwenden."
  fi
}

confirm_initial_setup_plan() {
  local phrase="$1" input=""
  read -rp "Zum Anwenden exakt '$phrase' eingeben: " input || true
  [[ "$input" == "$phrase" ]]
}

apply_initial_setup_plan() {
  [[ ! -e "$ENVFILE" ]] || die "Initialplan darf eine vorhandene .env nicht ueberschreiben."
  [[ -f "$ROOT/.env.example" ]] || die ".env.example fehlt."
  cp "$ROOT/.env.example" "$ENVFILE"
  chmod 0600 "$ENVFILE" || die "Dateirechte fuer $ENVFILE konnten nicht auf 0600 gesetzt werden."
  _TAXTRONIK_ENV_CREATED_THIS_RUN=1

  set_env DEPLOYMENT_METHOD "$_SETUP_METHOD"
  set_env TAXTRONIK_DEPLOY_CHANNEL "$_SETUP_DEPLOY_CHANNEL"
  set_env TAXTRONIK_IMAGE_PREFIX "$_SETUP_IMAGE_PREFIX"
  set_env TAXTRONIK_VERSION "$_SETUP_RELEASE_VERSION"
  set_env NEXTAUTH_URL "https://${_SETUP_STAFF_HOST}"
  set_env PORTAL_PUBLIC_URL "https://${_SETUP_PORTAL_HOST}"
  set_env N8N_HOST "$_SETUP_N8N_HOST"
  set_env N8N_WEBHOOK_URL "https://${_SETUP_N8N_HOST}/"
  set_env N8N_PROXY_HOPS 1
  set_env STAFF_COOKIE_DOMAIN "$_SETUP_STAFF_HOST"
  set_env PORTAL_COOKIE_DOMAIN "$_SETUP_PORTAL_HOST"
  set_env NEXTAUTH_TRUST_HOST true
  if [[ "$_SETUP_METHOD" == "traefik" ]]; then
    set_env TRUST_PROXY_REQUIRED true
    set_env TRAEFIK_ACME_EMAIL "$_SETUP_ACME_EMAIL"
  else
    set_env TRUST_PROXY_REQUIRED false
    set_env TRAEFIK_ACME_EMAIL ""
  fi
  set_env SMTP_HOST "$_SETUP_SMTP_HOST"
  set_env SMTP_PORT "$_SETUP_SMTP_PORT"
  set_env SMTP_FROM "$_SETUP_SMTP_FROM"
  set_env SMTP_USER "$_SETUP_SMTP_USER"
  set_env SMTP_PASSWORD "$_SETUP_SMTP_PASSWORD"
  set_env SIGNAL_DEPLOYMENT "$_SETUP_SIGNAL_MODE"
  set_env SIGNAL_DEPLOY_CHANNEL "$_SETUP_SIGNAL_CHANNEL"
  set_env SIGNAL_IMAGE "$_SETUP_SIGNAL_IMAGE"
  set_env SIGNAL_GIT_URL "$_SETUP_SIGNAL_GIT_URL"
  set_env SIGNAL_GIT_REF "$_SETUP_SIGNAL_GIT_REF"
  set_env SIGNAL_GIT_DIR "$_SETUP_SIGNAL_GIT_DIR"
  set_env RISK_LAYER_URL "$_SETUP_SIGNAL_URL"
  set_env RISK_LAYER_TOKEN "$_SETUP_SIGNAL_TOKEN"
  set_env RISK_LAYER_OPERATOR_TOKEN "$_SETUP_SIGNAL_OPERATOR_TOKEN"
  set_env TENANT_NAME "$_SETUP_TENANT_NAME"
  set_env ADMIN_EMAIL "$_SETUP_ADMIN_EMAIL"

  mark_initial_install_pending

  export TENANT_NAME="$_SETUP_TENANT_NAME"
  export ADMIN_EMAIL="$_SETUP_ADMIN_EMAIL"
}

configure_initial_deployment_interactive() {
  [[ ! -f "$ENVFILE" && -t 0 ]] || return 0
  [[ ! -e "$STATE" ]] || \
    die ".env fehlt, aber Installations-State ist vorhanden. Nicht als Erstinstallation ueberschreiben; .env aus dem Backup wiederherstellen."

  local choice="" input="" phrase=""
  _SETUP_METHOD="standard"
  _SETUP_DEPLOY_CHANNEL="source"
  _SETUP_IMAGE_PREFIX="taxtronik"
  _SETUP_RELEASE_VERSION=""
  _SETUP_STAFF_HOST=""
  _SETUP_PORTAL_HOST=""
  _SETUP_N8N_HOST=""
  _SETUP_ACME_EMAIL=""
  _SETUP_SMTP_HOST=""
  _SETUP_SMTP_PORT="587"
  _SETUP_SMTP_FROM=""
  _SETUP_SMTP_USER=""
  _SETUP_SMTP_PASSWORD=""
  _SETUP_SIGNAL_MODE="managed"
  _SETUP_SIGNAL_CHANNEL="source"
  _SETUP_SIGNAL_IMAGE=""
  _SETUP_SIGNAL_GIT_URL="$SIGNAL_GIT_URL_DEFAULT"
  _SETUP_SIGNAL_GIT_REF="$SIGNAL_GIT_REF_DEFAULT"
  _SETUP_SIGNAL_GIT_DIR="$(dirname "$ROOT")/signal"
  _SETUP_SIGNAL_URL=""
  _SETUP_SIGNAL_TOKEN=""
  _SETUP_SIGNAL_OPERATOR_TOKEN=""
  _SETUP_TENANT_NAME="Kanzlei"
  _SETUP_ADMIN_EMAIL=""

  printf '\nInitialsetup: Wie soll TaxTronik veroeffentlicht werden?\n'
  printf '  1) Standard (empfohlen fuer bestehende/verwaltete Server)\n'
  printf '     App nur auf 127.0.0.1; vorhandenen nginx/Caddy/Traefik selbst anbinden.\n'
  printf '  2) 1-Klick mit verwaltetem Traefik + Let\x27s Encrypt\n'
  printf '     NUR fuer eine komplett leere Linux-/Docker-Maschine.\n'
  read -rp 'Auswahl [1]: ' choice || true
  case "${choice:-1}" in
    1|standard) _SETUP_METHOD="standard" ;;
    2|traefik)
      _SETUP_METHOD="traefik"
      printf '\nACHTUNG: Der 1-Klick-Pfad beansprucht exklusiv Ports 80/443 und startet\n'
      printf 'einen eigenen Traefik. Er ist NICHT fuer Maschinen mit vorhandenen\n'
      printf 'Containern, Webservern, Reverse-Proxys oder TaxTronik-Daten gedacht.\n'
      printf 'Host-/Provider-Firewall und DNS bleiben Verantwortung des Betreibers.\n\n'
      assert_blank_host_for_traefik
      ;;
    *) die "Ungueltige Deployment-Auswahl: $choice" ;;
  esac

  printf '\nWelcher TaxTronik-Stand soll installiert werden?\n'
  printf '  1) Aktueller Git-Stand (empfohlen fuer Entwicklung/Vorabstaende)\n'
  printf '     Baut den ausgecheckten Commit lokal; keine Versionsangabe noetig.\n'
  printf '  2) Veroeffentlichtes Release\n'
  printf '     Zieht signierte Registry-Images; nur waehlen, wenn ein Release vorliegt.\n'
  read -rp 'Auswahl [1]: ' choice || true
  case "${choice:-1}" in
    1|source)
      _SETUP_DEPLOY_CHANNEL="source"
      _SETUP_IMAGE_PREFIX="taxtronik"
      _SETUP_RELEASE_VERSION="$(source_version_for_checkout)"
      ;;
    2|release)
      _SETUP_DEPLOY_CHANNEL="release"
      _SETUP_IMAGE_PREFIX="$TAXTRONIK_RELEASE_IMAGE_PREFIX_DEFAULT"
      while :; do
        read -rp 'Veroeffentlichte Release-Version (SemVer X.Y.Z): ' input || true
        _SETUP_RELEASE_VERSION="$input"
        [[ "$_SETUP_RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
        warn "Bitte den exakten Tag eines veroeffentlichten Releases eingeben, z. B. 1.4.0."
      done
      ;;
    *) die "Ungueltige Bezugsweg-Auswahl: $choice" ;;
  esac

  while :; do
    read -rp 'Kanzlei-/Mitarbeiterportal (vollstaendige Domain, z. B. portal.taxtronik.de): ' _SETUP_STAFF_HOST || true
    _SETUP_STAFF_HOST="${_SETUP_STAFF_HOST,,}"
    valid_public_fqdn "$_SETUP_STAFF_HOST" && break
    warn "Domain des Kanzlei-/Mitarbeiterportals ist ungueltig."
  done
  while :; do
    read -rp 'Mandantenportal (vollstaendige Domain, z. B. mandanten.taxtronik.de): ' _SETUP_PORTAL_HOST || true
    _SETUP_PORTAL_HOST="${_SETUP_PORTAL_HOST,,}"
    if valid_public_fqdn "$_SETUP_PORTAL_HOST" && [[ "$_SETUP_PORTAL_HOST" != "$_SETUP_STAFF_HOST" ]]; then break; fi
    warn "Mandantenportal-Domain muss gueltig und vom Kanzleiportal verschieden sein."
  done
  while :; do
    read -rp 'n8n-Administration (vollstaendige Domain, z. B. n8n.taxtronik.de): ' _SETUP_N8N_HOST || true
    _SETUP_N8N_HOST="${_SETUP_N8N_HOST,,}"
    if valid_public_fqdn "$_SETUP_N8N_HOST" && \
       [[ "$_SETUP_N8N_HOST" != "$_SETUP_STAFF_HOST" && "$_SETUP_N8N_HOST" != "$_SETUP_PORTAL_HOST" ]]; then break; fi
    warn "n8n-Domain muss gueltig und von beiden Portalen verschieden sein."
  done

  while :; do
    read -rp 'Admin-E-Mail: ' _SETUP_ADMIN_EMAIL || true
    valid_setup_email "$_SETUP_ADMIN_EMAIL" && break
    warn "Admin-E-Mail ist ungueltig."
  done
  read -rp 'Kanzlei-Name [Kanzlei]: ' input || true
  _SETUP_TENANT_NAME="${input:-Kanzlei}"
  [[ -n "${_SETUP_TENANT_NAME//[[:space:]]/}" ]] || die "Kanzlei-Name darf nicht leer sein."

  if [[ "$_SETUP_METHOD" == "traefik" ]]; then
    while :; do
      read -rp "Let's-Encrypt-E-Mail [${_SETUP_ADMIN_EMAIL}]: " input || true
      _SETUP_ACME_EMAIL="${input:-$_SETUP_ADMIN_EMAIL}"
      valid_setup_email "$_SETUP_ACME_EMAIL" && break
      warn "ACME-E-Mail ist ungueltig."
    done
  fi

  while :; do
    read -rp 'SMTP-Host (z. B. smtp.example.de): ' _SETUP_SMTP_HOST || true
    [[ -n "${_SETUP_SMTP_HOST//[[:space:]]/}" ]] && break
    warn "SMTP-Host darf nicht leer sein."
  done
  read -rp 'SMTP-Port [587]: ' input || true
  _SETUP_SMTP_PORT="${input:-587}"
  [[ "$_SETUP_SMTP_PORT" =~ ^[0-9]+$ ]] && (( 10#$_SETUP_SMTP_PORT >= 1 && 10#$_SETUP_SMTP_PORT <= 65535 )) || \
    die "SMTP-Port muss zwischen 1 und 65535 liegen."
  while :; do
    read -rp 'SMTP-Absender (z. B. TaxTronik <noreply@example.de>): ' _SETUP_SMTP_FROM || true
    [[ -n "${_SETUP_SMTP_FROM//[[:space:]]/}" ]] && break
    warn "SMTP-Absender darf nicht leer sein."
  done
  read -rp 'SMTP-Benutzer (optional): ' _SETUP_SMTP_USER || true
  if [[ -n "$_SETUP_SMTP_USER" ]]; then
    read -rsp 'SMTP-Passwort: ' _SETUP_SMTP_PASSWORD || true
    printf '\n'
    [[ -n "$_SETUP_SMTP_PASSWORD" ]] || die "SMTP-Passwort fehlt trotz gesetztem Benutzer."
  fi

  printf '\nSignal einrichten?\n'
  printf '  1) Mit TaxTronik verwalten - Docker (empfohlen)\n'
  printf '  2) Extern/nativ vorhandenes Signal anbinden\n'
  printf '  3) Signal deaktivieren\n'
  read -rp 'Auswahl [1]: ' choice || true
  case "${choice:-1}" in
    1|managed)
      _SETUP_SIGNAL_MODE="managed"
      printf '\nWie soll das von TaxTronik verwaltete Signal bereitgestellt werden?\n'
      printf '  1) Aktuellen Git-Stand lokal bauen (derzeit empfohlen)\n'
      printf '     Klont/aktualisiert Signal und baut ein CPU-Image ohne automatischen Indexaufbau.\n'
      printf '  2) Veroeffentlichtes Container-Image aus einer Registry\n'
      printf '     Nur waehlen, wenn das versionierte Image tatsaechlich veroeffentlicht ist.\n'
      read -rp 'Auswahl [1]: ' choice || true
      case "${choice:-1}" in
        1|source)
          _SETUP_SIGNAL_CHANNEL="source"
          read -rp "Signal-Git-Repository [$_SETUP_SIGNAL_GIT_URL]: " input || true
          _SETUP_SIGNAL_GIT_URL="${input:-$_SETUP_SIGNAL_GIT_URL}"
          valid_signal_git_url "$_SETUP_SIGNAL_GIT_URL" || die "Signal-Git-URL ist ungueltig oder enthaelt Zugangsdaten."
          read -rp "Signal-Git-Ref (Branch, Tag oder Commit) [$_SETUP_SIGNAL_GIT_REF]: " input || true
          _SETUP_SIGNAL_GIT_REF="${input:-$_SETUP_SIGNAL_GIT_REF}"
          valid_signal_git_ref "$_SETUP_SIGNAL_GIT_REF" || die "Signal-Git-Ref ist ungueltig."
          read -rp "Lokaler Signal-Checkout [$_SETUP_SIGNAL_GIT_DIR]: " input || true
          _SETUP_SIGNAL_GIT_DIR="${input:-$_SETUP_SIGNAL_GIT_DIR}"
          [[ "$_SETUP_SIGNAL_GIT_DIR" == /* && "$_SETUP_SIGNAL_GIT_DIR" != "/" && \
             "$_SETUP_SIGNAL_GIT_DIR" != "$ROOT" && "$_SETUP_SIGNAL_GIT_DIR" != "$ROOT/"* ]] || \
            die "Signal-Checkout braucht einen absoluten eigenen Pfad ausserhalb des TaxTronik-Repos."
          _SETUP_SIGNAL_IMAGE=""
          ;;
        2|image)
          _SETUP_SIGNAL_CHANNEL="image"
          read -rp "Versioniertes Signal-Image [$SIGNAL_MANAGED_IMAGE_DEFAULT]: " input || true
          _SETUP_SIGNAL_IMAGE="${input:-$SIGNAL_MANAGED_IMAGE_DEFAULT}"
          validate_signal_managed_image "$_SETUP_SIGNAL_IMAGE" || \
            die "Signal-Image braucht einen versionierten vX.Y.Z-Tag oder sha256-Digest; latest ist unzulaessig."
          _SETUP_SIGNAL_GIT_URL=""
          _SETUP_SIGNAL_GIT_REF=""
          _SETUP_SIGNAL_GIT_DIR=""
          ;;
        *) die "Ungueltige Signal-Bezugsweg-Auswahl: $choice" ;;
      esac
      ;;
    2|external)
      _SETUP_SIGNAL_MODE="external"
      _SETUP_SIGNAL_CHANNEL=""
      _SETUP_SIGNAL_IMAGE=""
      _SETUP_SIGNAL_GIT_URL=""
      _SETUP_SIGNAL_GIT_REF=""
      _SETUP_SIGNAL_GIT_DIR=""
      while :; do
        read -rp 'Signal-URL (aus TaxTronik-Containern erreichbar): ' _SETUP_SIGNAL_URL || true
        valid_http_url "$_SETUP_SIGNAL_URL" && break
        warn "Signal-URL ist ungueltig."
      done
      read -rsp 'Signal Bearer-Token (mindestens 32 Zeichen): ' _SETUP_SIGNAL_TOKEN || true; printf '\n'
      (( ${#_SETUP_SIGNAL_TOKEN} >= 32 )) || die "Signal Bearer-Token ist zu kurz."
      read -rsp 'Signal Operator-Token (optional, Enter = read-only): ' _SETUP_SIGNAL_OPERATOR_TOKEN || true; printf '\n'
      [[ -z "$_SETUP_SIGNAL_OPERATOR_TOKEN" || ${#_SETUP_SIGNAL_OPERATOR_TOKEN} -ge 32 ]] || \
        die "Signal Operator-Token ist zu kurz."
      [[ -z "$_SETUP_SIGNAL_OPERATOR_TOKEN" || "$_SETUP_SIGNAL_OPERATOR_TOKEN" != "$_SETUP_SIGNAL_TOKEN" ]] || \
        die "Signal Operator- und Bearer-Token muessen verschieden sein."
      ;;
    3|disabled)
      _SETUP_SIGNAL_MODE="disabled"
      _SETUP_SIGNAL_CHANNEL=""
      _SETUP_SIGNAL_IMAGE=""
      _SETUP_SIGNAL_GIT_URL=""
      _SETUP_SIGNAL_GIT_REF=""
      _SETUP_SIGNAL_GIT_DIR=""
      ;;
    *) die "Ungueltige Signal-Auswahl: $choice" ;;
  esac

  printf '\n================ Setup-Zusammenfassung ================\n'
  printf 'Deployment : %s\n' "$([[ "$_SETUP_METHOD" == "traefik" ]] && printf '1-Klick Traefik (leerer Host)' || printf 'Standard / vorhandener Reverse-Proxy')"
  if [[ "$_SETUP_DEPLOY_CHANNEL" == "source" ]]; then
    printf 'Quelle     : Git-Stand %s (lokaler Build)\n' "${_SETUP_RELEASE_VERSION#source-}"
  else
    printf 'Quelle     : Veroeffentlichtes Release v%s (Registry)\n' "$_SETUP_RELEASE_VERSION"
  fi
  printf 'Kanzlei-Web: https://%s\n' "$_SETUP_STAFF_HOST"
  printf 'Mandanten  : https://%s\n' "$_SETUP_PORTAL_HOST"
  printf 'n8n        : https://%s\n' "$_SETUP_N8N_HOST"
  [[ "$_SETUP_METHOD" == "traefik" ]] && printf 'TLS        : Let\x27s Encrypt fuer alle drei Domains\n'
  printf 'SMTP       : %s:%s, Zugang %s\n' "$_SETUP_SMTP_HOST" "$_SETUP_SMTP_PORT" "$([[ -n "$_SETUP_SMTP_USER" ]] && printf 'gesetzt' || printf 'ohne Login')"
  if [[ "$_SETUP_SIGNAL_MODE" == "managed" && "$_SETUP_SIGNAL_CHANNEL" == "source" ]]; then
    printf 'Signal     : verwaltet, Git %s @ %s -> %s\n' \
      "$_SETUP_SIGNAL_GIT_URL" "$_SETUP_SIGNAL_GIT_REF" "$_SETUP_SIGNAL_GIT_DIR"
    printf '             Kein automatischer Embedding-Indexaufbau\n'
  elif [[ "$_SETUP_SIGNAL_MODE" == "managed" ]]; then
    printf 'Signal     : verwaltet, Registry-Image %s\n' "$_SETUP_SIGNAL_IMAGE"
  else
    printf 'Signal     : %s\n' "$_SETUP_SIGNAL_MODE"
  fi
  printf 'Kanzleiname: %s\n' "$_SETUP_TENANT_NAME"
  printf 'Admin      : %s\n' "$_SETUP_ADMIN_EMAIL"
  if [[ "$_SETUP_METHOD" == "standard" ]]; then
    printf 'Hinweis     : TLS/Proxy-Konfiguration bleibt unveraendert beim Betreiber.\n'
    phrase="KONFIGURATION UEBERNEHMEN"
  else
    printf 'WARNUNG     : Nur fuer komplett leere Maschine; Ports 80/443 werden exklusiv.\n'
    printf 'Host-Setup  : Fehlende Basispakete, Docker/Compose, Node %s und pnpm %s werden installiert.\n' \
      "$HOST_NODE_VERSION" "$HOST_PNPM_VERSION"
    phrase="LEERE MASCHINE INSTALLIEREN"
  fi
  printf '=========================================================\n'
  confirm_initial_setup_plan "$phrase" || die "Initialsetup ohne Aenderungen abgebrochen."
  apply_initial_setup_plan
  info "Bestaetigte Initialkonfiguration wurde nach .env uebernommen."
}

# Expliziter Besitzvertrag fuer Signal. Der Funktionsname bleibt wegen der
# historischen RISK_LAYER_* API- und Env-Namen bestandskompatibel.
configure_risk_layer_interactive() {
  local mode="${SIGNAL_DEPLOYMENT:-}" choice="" channel="${SIGNAL_DEPLOY_CHANNEL:-}"
  RISK_LAYER_URL="${RISK_LAYER_URL:-}"
  RISK_LAYER_TOKEN="${RISK_LAYER_TOKEN:-}"
  RISK_LAYER_OPERATOR_TOKEN="${RISK_LAYER_OPERATOR_TOKEN:-}"
  SIGNAL_IMAGE="${SIGNAL_IMAGE:-auto}"
  SIGNAL_GIT_URL="${SIGNAL_GIT_URL:-$SIGNAL_GIT_URL_DEFAULT}"
  SIGNAL_GIT_REF="${SIGNAL_GIT_REF:-$SIGNAL_GIT_REF_DEFAULT}"
  SIGNAL_GIT_DIR="${SIGNAL_GIT_DIR:-$(dirname "$ROOT")/signal}"
  RISK_LAYER_EMB_DEVICE="${RISK_LAYER_EMB_DEVICE:-cpu}"

  if [[ -z "$mode" ]]; then
    mode="$(signal_deployment_mode)"
    # Eine komplett leere Erstinstallation soll bewusst entscheiden. Bei
    # Bestandswerten wird lediglich der sichere, deterministische Modus
    # persistiert; dadurch fragt ein normales Update nicht erneut.
    if [[ -z "$RISK_LAYER_URL" && -t 0 ]]; then
      printf '\nSignal einrichten?\n'
      printf '  1) Mit TaxTronik verwalten - Docker (empfohlen)\n'
      printf '  2) Extern/nativ vorhandenes Signal anbinden\n'
      printf '  3) Signal deaktivieren\n'
      read -rp 'Auswahl [1]: ' choice || true
      case "${choice:-1}" in
        1|managed) mode="managed" ;;
        2|external) mode="external" ;;
        3|disabled) mode="disabled" ;;
        *) die "Ungueltige Signal-Auswahl: $choice" ;;
      esac
    fi
  fi

  case "$mode" in
    managed)
      if [[ -z "$channel" ]]; then
        if [[ -t 0 ]]; then
          printf '\nBezugsweg fuer das verwaltete Signal festlegen:\n'
          printf '  1) Git-Quellstand lokal bauen (derzeit empfohlen)\n'
          printf '  2) Veroeffentlichtes Registry-Image beziehen\n'
          read -rp 'Auswahl [1]: ' choice || true
          case "${choice:-1}" in
            1|source) channel="source" ;;
            2|image) channel="image" ;;
            *) die "Ungueltige Signal-Bezugsweg-Auswahl: $choice" ;;
          esac
        else
          channel="image"
          warn "SIGNAL_DEPLOY_CHANNEL fehlt; bestandskompatibel wird image verwendet. Fuer Git-Build source setzen."
        fi
      fi
      [[ "$channel" == "source" || "$channel" == "image" ]] || \
        die "SIGNAL_DEPLOY_CHANNEL muss source oder image sein."
      if [[ "$channel" == "source" ]]; then
        prompt "Signal-Git-Repository" SIGNAL_GIT_URL "$SIGNAL_GIT_URL_DEFAULT"
        prompt "Signal-Git-Ref (Branch, Tag oder Commit)" SIGNAL_GIT_REF "$SIGNAL_GIT_REF_DEFAULT"
        prompt "Lokaler Signal-Checkout" SIGNAL_GIT_DIR "$(dirname "$ROOT")/signal"
        valid_signal_git_url "$SIGNAL_GIT_URL" || \
          die "Signal-Git-URL ist ungueltig oder enthaelt eingebettete Zugangsdaten."
        valid_signal_git_ref "$SIGNAL_GIT_REF" || die "Signal-Git-Ref ist ungueltig."
        [[ "$SIGNAL_GIT_DIR" == /* && "$SIGNAL_GIT_DIR" != "/" && \
           "$SIGNAL_GIT_DIR" != "$ROOT" && "$SIGNAL_GIT_DIR" != "$ROOT/"* ]] || \
          die "Signal-Checkout braucht einen absoluten eigenen Pfad ausserhalb des TaxTronik-Repos."
        SIGNAL_IMAGE=""
      else
        SIGNAL_GIT_URL=""
        SIGNAL_GIT_REF=""
        SIGNAL_GIT_DIR=""
        SIGNAL_IMAGE="${SIGNAL_IMAGE:-auto}"
      fi
      RISK_LAYER_URL="http://risk-layer:8000"
      [[ ${#RISK_LAYER_TOKEN} -ge 32 ]] || RISK_LAYER_TOKEN="$(rand_b64 32)"
      if [[ ${#RISK_LAYER_OPERATOR_TOKEN} -lt 32 || "$RISK_LAYER_OPERATOR_TOKEN" == "$RISK_LAYER_TOKEN" ]]; then
        local token_attempt
        RISK_LAYER_OPERATOR_TOKEN=""
        for token_attempt in 1 2 3; do
          RISK_LAYER_OPERATOR_TOKEN="$(rand_b64 32)"
          [[ ${#RISK_LAYER_OPERATOR_TOKEN} -ge 32 && "$RISK_LAYER_OPERATOR_TOKEN" != "$RISK_LAYER_TOKEN" ]] && break
        done
        [[ ${#RISK_LAYER_OPERATOR_TOKEN} -ge 32 && "$RISK_LAYER_OPERATOR_TOKEN" != "$RISK_LAYER_TOKEN" ]] || \
          die "Getrenntes Signal-Operator-Token konnte nicht sicher generiert werden."
      fi
      if [[ "$channel" == "image" ]]; then
        SIGNAL_IMAGE="${SIGNAL_IMAGE:-auto}"
      else
        SIGNAL_IMAGE=""
      fi
      RISK_LAYER_EMB_DEVICE="cpu"
      info "Signal wird durch TaxTronik verwaltet ($channel); URL und getrennte Secrets wurden automatisch provisioniert."
      ;;
    external)
      prompt "Signal-URL (aus den TaxTronik-Containern erreichbar)" RISK_LAYER_URL "$RISK_LAYER_URL"
      prompt "Signal Bearer-Token (min 32 Zeichen)" RISK_LAYER_TOKEN "$RISK_LAYER_TOKEN"
      if [[ -z "$RISK_LAYER_OPERATOR_TOKEN" && -t 0 ]]; then
        read -rsp "Signal Operator-Token (optional, Enter = read-only): " RISK_LAYER_OPERATOR_TOKEN || true
        printf '\n'
      fi
      SIGNAL_IMAGE=""
      channel=""
      SIGNAL_GIT_URL=""
      SIGNAL_GIT_REF=""
      SIGNAL_GIT_DIR=""
      info "Signal ist extern verwaltet; TaxTronik wird weder Installation noch Updates anfassen."
      ;;
    disabled)
      RISK_LAYER_URL=""
      RISK_LAYER_TOKEN=""
      RISK_LAYER_OPERATOR_TOKEN=""
      SIGNAL_IMAGE=""
      channel=""
      SIGNAL_GIT_URL=""
      SIGNAL_GIT_REF=""
      SIGNAL_GIT_DIR=""
      ;;
    *) die "SIGNAL_DEPLOYMENT muss managed, external oder disabled sein (aktuell: $mode)." ;;
  esac

  set_env SIGNAL_DEPLOYMENT "$mode"
  set_env SIGNAL_DEPLOY_CHANNEL "$channel"
  set_env SIGNAL_IMAGE "$SIGNAL_IMAGE"
  set_env SIGNAL_GIT_URL "$SIGNAL_GIT_URL"
  set_env SIGNAL_GIT_REF "$SIGNAL_GIT_REF"
  set_env SIGNAL_GIT_DIR "$SIGNAL_GIT_DIR"
  set_env RISK_LAYER_URL "$RISK_LAYER_URL"
  set_env RISK_LAYER_TOKEN "$RISK_LAYER_TOKEN"
  set_env RISK_LAYER_OPERATOR_TOKEN "$RISK_LAYER_OPERATOR_TOKEN"
  set_env RISK_LAYER_EMB_DEVICE "$RISK_LAYER_EMB_DEVICE"
  # Bestandswert wird nur aus der Env entfernt; Host-Daten werden niemals
  # geloescht. Verwaltete Images tragen ihr Festwissen selbst, externe Dienste
  # besitzen ihre Daten ohnehin ausserhalb von TaxTronik.
  set_env RISK_LAYER_FESTWISSEN_DIR ""
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
  local url="${1:-}" authority
  [[ "$url" == *://* ]] || return 0
  authority="${url#*://}"
  authority="${authority%%/*}"
  authority="${authority##*@}"
  if [[ "$authority" == \[*\]* ]]; then
    authority="${authority#\[}"; authority="${authority%%\]*}"
  else
    authority="${authority%%:*}"
  fi
  printf '%s' "$authority"
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
    read -rp "Oeffentliche Mandantenportal-URL (PORTAL_PUBLIC_URL, leer = Single-Host) []: " input || true
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
      read -rp "Kanzlei-Cookie-Domain (STAFF_COOKIE_DOMAIN, nur Hostname) [$staff_host]: " input || true
      set_env STAFF_COOKIE_DOMAIN "${input:-$staff_host}"
    fi
    if [[ -z "$portal_dom" ]]; then
      read -rp "Mandanten-Cookie-Domain (PORTAL_COOKIE_DOMAIN, nur Hostname) [$portal_host]: " input || true
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

configure_n8n_domain_interactive() {
  load_env
  local host="${N8N_HOST:-}" input="" staff_host portal_host
  staff_host="$(url_hostname "${NEXTAUTH_URL:-}")"
  portal_host="$(url_hostname "${PORTAL_PUBLIC_URL:-}")"
  staff_host="${staff_host,,}"; portal_host="${portal_host,,}"

  if valid_public_fqdn "${host,,}" && [[ "${host,,}" != "$staff_host" && "${host,,}" != "$portal_host" ]]; then
    [[ "$host" == "${host,,}" ]] || set_env N8N_HOST "${host,,}"
    [[ "${N8N_WEBHOOK_URL:-}" == "https://${host,,}/" ]] || set_env N8N_WEBHOOK_URL "https://${host,,}/"
    [[ "${N8N_PROXY_HOPS:-}" =~ ^[1-9][0-9]*$ ]] || set_env N8N_PROXY_HOPS 1
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "N8N_HOST fehlt/ist ungueltig; eigene n8n-Domain in .env setzen."
    return 0
  fi
  while :; do
    read -rp 'n8n-Administration (vollstaendige eigene Domain, z. B. n8n.taxtronik.de): ' input || true
    input="${input,,}"
    if valid_public_fqdn "$input" && [[ "$input" != "$staff_host" && "$input" != "$portal_host" ]]; then break; fi
    warn "n8n-Domain muss gueltig und von Kanzlei- und Mandantenportal verschieden sein."
  done
  set_env N8N_HOST "$input"
  set_env N8N_WEBHOOK_URL "https://${input}/"
  set_env N8N_PROXY_HOPS 1
}

state_value() {
  local key="$1"
  [[ -f "$STATE" ]] || return 0
  grep -E "^${key}=" "$STATE" | head -n1 | cut -d= -f2- || true
}

pending_migration_value() {
  local key="$1"
  [[ -f "$MIGRATION_PENDING" ]] || return 0
  grep -E "^${key}=" "$MIGRATION_PENDING" | head -n1 | cut -d= -f2- || true
}

# Ermittelt am echten DB-Migrationsjournal, ob `migrate deploy` mindestens eine
# Migration anwenden wird. Jeder Probe-Fehler wird als unknown behandelt; ein
# Rollback darf dann später nicht optimistisch alten Code starten.
pending_database_migration_requirement() {
  local applied migration name query_out
  query_out="$(compose --infra exec -T postgres psql -U taxtronik -d taxtronik -Atc \
    'SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' \
    2>/dev/null)" || { printf 'unknown'; return 0; }
  applied=$'\n'"$query_out"$'\n'
  for migration in "$ROOT"/packages/db/prisma/migrations/*; do
    [[ -d "$migration" ]] || continue
    name="${migration##*/}"
    [[ "$applied" == *$'\n'"$name"$'\n'* ]] || { printf 'true'; return 0; }
  done
  printf 'false'
}

active_writer_release_commit() {
  if [[ -n "${TAXTRONIK_RELEASE_COMMIT:-}" ]]; then
    printf '%s' "$TAXTRONIK_RELEASE_COMMIT"
  else
    git -C "$ROOT" rev-parse HEAD 2>/dev/null || true
  fi
}

# Zentraler Start-Guard fuer alle Writer (app, worker, n8n). Infrastruktur
# bleibt separat ueber `compose --infra` startbar. Ein Produktionsrestore kann
# ausschliesslich durch den exakt passenden Rollback aktiviert werden. Ein
# offener Migrationsvertrag erlaubt nur den passenden internen Deploy-Start
# oder, falls garantiert keine Migration ausstand, den exakten Quell-Rollback.
assert_writer_start_authorized() {
  local reason="${_TAXTRONIK_INTERNAL_WRITER_START_REASON:-}"
  local target="${_TAXTRONIK_INTERNAL_WRITER_START_TARGET:-}"
  local restored_target restored_status pending_requirement pending_source pending_source_commit
  local pending_target pending_target_commit active_commit

  if [[ -f "$DB_RESTORE_AUTHORIZATION" && -f "$MIGRATION_PENDING" ]]; then
    die "Writer-Start blockiert: DB-Restore- und Migrations-Pending-Marker existieren gleichzeitig. Markerzustand vor jeder Aktivierung klaeren."
  fi

  if [[ -f "$DB_RESTORE_AUTHORIZATION" ]]; then
    restored_target="$(database_restore_authorized_target)"
    restored_status="$(database_restore_authorization_status)"
    [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
      die "Writer-Start blockiert: DB-Restore-Autorisierung ist ungueltig."
    [[ "$restored_status" == "ready" ]] || \
      die "Writer-Start blockiert: Produktions-DB-Restore ist nicht nachweislich erfolgreich abgeschlossen (Status: ${restored_status:-ungueltig})."
    [[ "$reason" == "rollback" && "$target" == "$restored_target" ]] || \
      die "Writer-Start blockiert: Die restaurierte Produktions-DB darf nur mit './taxtronik rollback $restored_target' aktiviert werden."
    return 0
  fi

  [[ -f "$MIGRATION_PENDING" ]] || return 0
  pending_requirement="$(pending_migration_value requires_db_restore)"
  pending_source="$(pending_migration_value source_version)"
  pending_source_commit="$(pending_migration_value source_commit)"
  pending_target="$(pending_migration_value target_version)"
  pending_target_commit="$(pending_migration_value target_commit)"
  [[ "$pending_requirement" == "true" || "$pending_requirement" == "false" || \
     "$pending_requirement" == "unknown" ]] || \
    die "Writer-Start blockiert: Migrations-Pending-Marker enthaelt keinen gueltigen Restore-Status."
  [[ -n "$pending_target" && "$pending_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Writer-Start blockiert: Migrations-Pending-Zielvertrag ist unvollstaendig oder ungueltig."
  active_commit="$(active_writer_release_commit)"

  if [[ "$reason" == "deploy" && "$target" == "$pending_target" && \
        "$active_commit" == "$pending_target_commit" ]]; then
    return 0
  fi
  if [[ "$reason" == "rollback" && "$pending_requirement" == "false" && \
        -n "$pending_source" && "$target" == "$pending_source" && \
        "$pending_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
        "$active_commit" == "$pending_source_commit" ]]; then
    return 0
  fi

  die "Writer-Start blockiert: Nicht finalisierter Migrationsvertrag (${pending_source:-Erstinstallation} -> $pending_target, Restore-Status: $pending_requirement). deploy/update bzw. den sicheren Restore-/Rollback-Pfad verwenden."
}

assert_no_database_restore_pending() {
  local restored_target
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  restored_target="$(database_restore_authorized_target)"
  [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "DB-Restore-Autorisierung ist ungueltig; Deploy/Update bleibt blockiert."
  die "Produktions-DB wurde restauriert. Deploy/Update ist bis zur Aktivierung durch './taxtronik rollback $restored_target' blockiert."
}

merge_migration_restore_requirement() {
  local existing="$1" fresh="$2"
  [[ "$existing" == "true" || "$existing" == "false" || "$existing" == "unknown" ]] || \
    existing="unknown"
  [[ "$fresh" == "true" || "$fresh" == "false" || "$fresh" == "unknown" ]] || \
    fresh="unknown"
  if [[ "$existing" == "true" || "$fresh" == "true" ]]; then
    printf 'true'
  elif [[ "$existing" == "unknown" || "$fresh" == "unknown" ]]; then
    printf 'unknown'
  else
    printf 'false'
  fi
}

gwg_034_migration_is_fixed() {
  local migration="$ROOT/packages/db/prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql"
  local unsafe_count safe_count
  [[ -f "$migration" ]] || return 1
  unsafe_count="$(grep -Ec "'app\.destroy_gwg_(check|document_versions)\(uuid\)'::regprocedure" "$migration" || true)"
  safe_count="$(grep -Ec "pg_catalog\.to_regprocedure\('app\.destroy_gwg_(check|document_versions)\(uuid\)'\)" "$migration" || true)"
  [[ "$unsafe_count" == "0" && "$safe_count" == "7" ]]
}

database_has_recoverable_gwg_034_failure() {
  local result
  result="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT CASE WHEN
        EXISTS (
          SELECT 1
            FROM public._prisma_migrations
           WHERE migration_name = '20260801003400_gwg_fail_closed_and_destruction'
             AND finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
             AND logs LIKE '%42883%'
             AND logs LIKE '%destroy_gwg_check(uuid)%'
        )
        AND pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE (table_schema, table_name, column_name) IN (
             ('public', 'gwg_check', 'legal_form'),
             ('public', 'gwg_check', 'register_number'),
             ('public', 'gwg_check', 'register_authority'),
             ('public', 'gwg_check', 'no_register_entry'),
             ('public', 'gwg_check', 'representative_names'),
             ('public', 'gwg_check', 'ownership_structure_notes'),
             ('public', 'document', 'gwg_onboarding_invite_id'),
             ('public', 'document', 'gwg_destruction_requested_at'),
             ('public', 'document', 'gwg_destruction_requested_by'),
             ('public', 'document', 'gwg_destruction_error'),
             ('public', 'document', 'gwg_destroyed_at')
           )
        )
        THEN 'yes' ELSE 'no'
      END" 2>/dev/null)" || return 1
  [[ "$result" == "yes" ]]
}

database_has_gwg_034_invariants() {
  local result
  result="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      /* gwg_034_schema_invariants */
      SELECT CASE WHEN
        NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('gwg_check', 'legal_form', 'text', FALSE),
                ('gwg_check', 'register_number', 'text', FALSE),
                ('gwg_check', 'register_authority', 'text', FALSE),
                ('gwg_check', 'no_register_entry', 'bool', TRUE),
                ('gwg_check', 'representative_names', '_text', TRUE),
                ('gwg_check', 'ownership_structure_notes', 'text', FALSE),
                ('document', 'gwg_onboarding_invite_id', 'uuid', FALSE),
                ('document', 'gwg_destruction_requested_at', 'timestamptz', FALSE),
                ('document', 'gwg_destruction_requested_by', 'uuid', FALSE),
                ('document', 'gwg_destruction_error', 'text', FALSE),
                ('document', 'gwg_destroyed_at', 'timestamptz', FALSE)
            ) expected(table_name, column_name, udt_name, must_be_not_null)
            LEFT JOIN information_schema.columns c
              ON c.table_schema = 'public'
             AND c.table_name = expected.table_name
             AND c.column_name = expected.column_name
             AND c.udt_name = expected.udt_name
           WHERE c.column_name IS NULL
              OR (expected.must_be_not_null AND c.is_nullable <> 'NO')
        )
        AND pg_catalog.to_regclass('public.document_gwg_invite_idx') IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint con
           WHERE con.conname = 'document_gwg_invite_fk'
             AND con.contype = 'f'
             AND con.conrelid = pg_catalog.to_regclass('public.document')
        )
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint con
           WHERE con.conname = 'gwg_invite_check_fkey'
             AND con.contype = 'f'
             AND con.conrelid = pg_catalog.to_regclass('public.gwg_onboarding_invite')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('app.guard_gwg_document_invite_and_claim()', FALSE),
                ('app.guard_gwg_id_document_scope_and_claim()', FALSE),
                ('app.guard_gwg_invite_check_scope_and_claim()', FALSE),
                ('app.freeze_gwg_claim_references()', FALSE),
                ('app.enforce_client_active_for_document()', FALSE),
                ('app.enforce_client_allow_active_requires_gwg()', FALSE),
                ('app.protect_verified_gwg_legal_snapshot()', FALSE),
                ('app.protect_verified_gwg_beneficial_owner()', FALSE),
                ('app.guard_gwg_check_hard_delete()', FALSE),
                ('app.gwg_deactivate_client_without_valid_check()', FALSE),
                ('app.destroy_gwg_check(uuid)', TRUE),
                ('app.protect_immutable_document_version()', FALSE),
                ('app.assert_gwg_document_destruction_due(uuid)', TRUE),
                ('app.destroy_gwg_document_versions(uuid)', TRUE),
                ('app.block_version_during_gwg_destruction()', FALSE)
            ) expected(signature, must_be_security_definer)
            LEFT JOIN pg_catalog.pg_proc p
              ON p.oid = pg_catalog.to_regprocedure(expected.signature)
           WHERE p.oid IS NULL
              OR (expected.must_be_security_definer AND NOT p.prosecdef)
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('document', 'document_gwg_invite_scope_and_claim', 'app.guard_gwg_document_invite_and_claim()'),
                ('gwg_id_document', 'gwg_id_document_scope_and_claim', 'app.guard_gwg_id_document_scope_and_claim()'),
                ('gwg_onboarding_invite', 'gwg_invite_check_scope_and_claim', 'app.guard_gwg_invite_check_scope_and_claim()'),
                ('client', 'client_freeze_gwg_claim', 'app.freeze_gwg_claim_references()'),
                ('gwg_check', 'gwg_check_freeze_gwg_claim', 'app.freeze_gwg_claim_references()'),
                ('gwg_check', 'gwg_check_verified_legal_snapshot_immutable', 'app.protect_verified_gwg_legal_snapshot()'),
                ('gwg_beneficial_owner', 'gwg_beneficial_owner_verified_snapshot_immutable', 'app.protect_verified_gwg_beneficial_owner()'),
                ('gwg_check', 'gwg_check_no_hard_delete', 'app.guard_gwg_check_hard_delete()'),
                ('gwg_check', 'gwg_check_fail_closed_client', 'app.gwg_deactivate_client_without_valid_check()'),
                ('document_version', 'document_version_block_gwg_destruction', 'app.block_version_during_gwg_destruction()')
            ) expected(table_name, trigger_name, function_signature)
            LEFT JOIN pg_catalog.pg_trigger t
              ON t.tgname = expected.trigger_name
             AND t.tgrelid = pg_catalog.to_regclass('public.' || expected.table_name)
             AND t.tgfoid = pg_catalog.to_regprocedure(expected.function_signature)
             AND NOT t.tgisinternal
             AND t.tgenabled IN ('O', 'A')
           WHERE t.oid IS NULL
        )
        AND COALESCE((
          SELECT bool_and(pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE'))
            FROM pg_catalog.pg_roles r
            CROSS JOIN unnest(ARRAY[
              pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)'),
              pg_catalog.to_regprocedure('app.assert_gwg_document_destruction_due(uuid)'),
              pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
            ]) AS functions(function_oid)
            JOIN pg_catalog.pg_proc p ON p.oid = function_oid
           WHERE r.rolname = 'taxtronik_app'
        ), FALSE)
        AND COALESCE((
          SELECT NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE')
            FROM pg_catalog.pg_roles r
            CROSS JOIN pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE r.rolname = 'taxtronik_app'
             AND n.nspname = 'public'
             AND c.relname = 'document_version'
        ), FALSE)
        AND NOT EXISTS (
          SELECT 1
            FROM unnest(ARRAY[
              pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)'),
              pg_catalog.to_regprocedure('app.assert_gwg_document_destruction_due(uuid)'),
              pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
            ]) AS functions(function_oid)
            JOIN pg_catalog.pg_proc p ON p.oid = function_oid
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
           WHERE acl.grantee = 0
             AND acl.privilege_type = 'EXECUTE'
        )
        THEN 'yes' ELSE 'no'
      END" 2>/dev/null)" || return 1
  [[ "$result" == "yes" ]]
}

database_has_gwg_identity_invariants() {
  local result
  result="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      /* gwg_043_schema_invariants */
      SELECT CASE WHEN
        pg_catalog.to_regclass('public.gwg_representative') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('gwg_check', 'identity_assignment_required', 'bool', TRUE),
                ('gwg_id_document', 'document_set_id', 'uuid', TRUE),
                ('gwg_id_document', 'natural_client_subject_id', 'uuid', FALSE),
                ('gwg_id_document', 'beneficial_owner_subject_id', 'uuid', FALSE),
                ('gwg_id_document', 'representative_subject_id', 'uuid', FALSE),
                ('gwg_id_document', 'identity_assignment_confirmed_at', 'timestamptz', FALSE),
                ('gwg_id_document', 'identity_assignment_confirmed_by', 'uuid', FALSE),
                ('gwg_representative', 'id', 'uuid', TRUE),
                ('gwg_representative', 'gwg_check_id', 'uuid', TRUE),
                ('gwg_representative', 'full_name', 'text', TRUE),
                ('gwg_representative', 'position', 'int4', TRUE),
                ('gwg_representative', 'created_at', 'timestamptz', TRUE),
                ('gwg_representative', 'updated_at', 'timestamptz', TRUE)
            ) expected(table_name, column_name, udt_name, must_be_not_null)
            LEFT JOIN information_schema.columns c
              ON c.table_schema = 'public'
             AND c.table_name = expected.table_name
             AND c.column_name = expected.column_name
             AND c.udt_name = expected.udt_name
           WHERE c.column_name IS NULL
              OR (expected.must_be_not_null AND c.is_nullable <> 'NO')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('gwg_check', 'gwg_check_identity_assignment_required_state', 'c'),
                ('gwg_representative', 'gwg_representative_pkey', 'p'),
                ('gwg_representative', 'gwg_representative_name_not_blank', 'c'),
                ('gwg_representative', 'gwg_representative_position_nonnegative', 'c'),
                ('gwg_representative', 'gwg_representative_gwg_check_id_position_key', 'u'),
                ('gwg_representative', 'gwg_representative_gwg_check_id_fkey', 'f'),
                ('gwg_id_document', 'gwg_id_document_gwg_check_id_document_id_key', 'u'),
                ('gwg_id_document', 'gwg_id_document_natural_client_subject_id_fkey', 'f'),
                ('gwg_id_document', 'gwg_id_document_beneficial_owner_subject_id_fkey', 'f'),
                ('gwg_id_document', 'gwg_id_document_representative_subject_id_fkey', 'f'),
                ('gwg_id_document', 'gwg_id_document_identity_subject_count', 'c'),
                ('gwg_id_document', 'gwg_id_document_identity_subject_personal_type', 'c'),
                ('gwg_id_document', 'gwg_id_document_identity_confirmation_complete', 'c')
            ) expected(table_name, constraint_name, constraint_type)
            LEFT JOIN pg_catalog.pg_constraint con
              ON con.conname = expected.constraint_name
             AND con.contype = expected.constraint_type::"char"
             AND con.conrelid = pg_catalog.to_regclass('public.' || expected.table_name)
             AND con.convalidated
           WHERE con.oid IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('public.gwg_representative_gwg_check_id_idx'),
                ('public.gwg_id_document_gwg_check_id_document_set_id_idx'),
                ('public.gwg_id_document_natural_client_subject_id_idx'),
                ('public.gwg_id_document_beneficial_owner_subject_id_idx'),
                ('public.gwg_id_document_representative_subject_id_idx')
            ) expected(index_name)
           WHERE pg_catalog.to_regclass(expected.index_name) IS NULL
        )
        AND COALESCE((
          SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c
           WHERE c.oid = pg_catalog.to_regclass('public.gwg_representative')
        ), FALSE)
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_policy policy
           WHERE policy.polname = 'gwg_representative_isolation'
             AND policy.polrelid = pg_catalog.to_regclass('public.gwg_representative')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('app.guard_gwg_id_document_subject_and_set()'),
                ('app.enforce_gwg_document_set_consistency()'),
                ('app.protect_verified_gwg_representative()'),
                ('app.purge_gwg_representatives_after_destruction()'),
                ('app.invalidate_gwg_beneficial_owner_identity_assignment()'),
                ('app.gwg_check_has_confirmed_identity(uuid)'),
                ('app.enforce_gwg_identity_assignment_on_verification()')
            ) expected(signature)
            LEFT JOIN pg_catalog.pg_proc p
              ON p.oid = pg_catalog.to_regprocedure(expected.signature)
           WHERE p.oid IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (
              VALUES
                ('gwg_id_document', 'gwg_id_document_subject_and_set_guard', 'app.guard_gwg_id_document_subject_and_set()'),
                ('gwg_id_document', 'gwg_document_set_consistency', 'app.enforce_gwg_document_set_consistency()'),
                ('gwg_representative', 'gwg_representative_verified_snapshot_immutable', 'app.protect_verified_gwg_representative()'),
                ('gwg_check', 'gwg_check_purge_representatives_after_destruction', 'app.purge_gwg_representatives_after_destruction()'),
                ('gwg_beneficial_owner', 'gwg_beneficial_owner_identity_assignment_invalidate', 'app.invalidate_gwg_beneficial_owner_identity_assignment()'),
                ('gwg_check', '00_gwg_check_identity_verification_guard', 'app.enforce_gwg_identity_assignment_on_verification()')
            ) expected(table_name, trigger_name, function_signature)
            LEFT JOIN pg_catalog.pg_trigger t
              ON t.tgname = expected.trigger_name
             AND t.tgrelid = pg_catalog.to_regclass('public.' || expected.table_name)
             AND t.tgfoid = pg_catalog.to_regprocedure(expected.function_signature)
             AND NOT t.tgisinternal
             AND t.tgenabled IN ('O', 'A')
           WHERE t.oid IS NULL
        )
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger t
           WHERE t.tgname = 'gwg_document_set_consistency'
             AND t.tgrelid = pg_catalog.to_regclass('public.gwg_id_document')
             AND t.tgfoid = pg_catalog.to_regprocedure('app.enforce_gwg_document_set_consistency()')
             AND NOT t.tgisinternal
             AND t.tgenabled IN ('O', 'A')
             AND t.tgconstraint <> 0
             AND t.tgdeferrable
             AND t.tginitdeferred
        )
        AND COALESCE((
          SELECT pg_catalog.has_function_privilege(
                   r.oid,
                   pg_catalog.to_regprocedure('app.gwg_check_has_confirmed_identity(uuid)'),
                   'EXECUTE'
                 )
            FROM pg_catalog.pg_roles r
           WHERE r.rolname = 'taxtronik_app'
        ), FALSE)
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_proc p
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
           WHERE p.oid = pg_catalog.to_regprocedure('app.gwg_check_has_confirmed_identity(uuid)')
             AND acl.grantee = 0
             AND acl.privilege_type = 'EXECUTE'
        )
        THEN 'yes' ELSE 'no'
      END" 2>/dev/null)" || return 1
  [[ "$result" == "yes" ]]
}

database_has_gwg_044_invariants() {
  local result
  result="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      /* gwg_044_schema_invariants */
      SELECT CASE WHEN
        EXISTS (
          SELECT 1
           FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.block_version_during_gwg_destruction()')
             AND pg_catalog.strpos(p.prosrc, 'public.\"gwg_id_document\"') > 0
             AND pg_catalog.strpos(p.prosrc, 'app.gwg_destroy_document_id') > 0
             AND pg_catalog.strpos(p.prosrc, 'authorized_delete') > 0
             AND pg_catalog.strpos(p.prosrc, 'FOR UPDATE') > 0
        )
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger t
           WHERE t.tgname = 'document_version_block_gwg_destruction'
             AND t.tgrelid = pg_catalog.to_regclass('public.document_version')
             AND t.tgfoid = pg_catalog.to_regprocedure('app.block_version_during_gwg_destruction()')
             AND NOT t.tgisinternal
             AND t.tgenabled IN ('O', 'A')
        )
        THEN 'yes' ELSE 'no'
      END" 2>/dev/null)" || return 1
  [[ "$result" == "yes" ]]
}

database_has_gwg_invariants_for_checkout() {
  local migrations="$ROOT/packages/db/prisma/migrations"

  if [[ -d "$migrations/20260801003400_gwg_fail_closed_and_destruction" ||
        -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_034_invariants || return 1
  fi
  if [[ -d "$migrations/20260801004300_gwg_identity_subjects_and_document_sets" ||
        -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_identity_invariants || return 1
  fi
  if [[ -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_044_invariants || return 1
  fi
}

database_is_fully_migrated_for_commit() {
  local commit="$1" open applied migrations migration name
  local requires_gwg_034=0 requires_gwg_identity=0 requires_gwg_044=0
  [[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1

  # Bei einem Legacy-Retry kann der neue Checkout bereits weitere Migrationen
  # enthalten. Entscheidend ist, dass die DB den im bestehenden Pending-Marker
  # gebundenen Ziel-Commit vollstaendig erreicht hat; erst danach duerfen dessen
  # Nachfolger im weiterhin restore-pflichtigen Vertrag angewendet werden.
  migrations="$(git -C "$ROOT" ls-tree -d --name-only \
    "$commit:packages/db/prisma/migrations" 2>/dev/null)" || return 1
  [[ -n "$migrations" ]] || return 1

  open="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT CASE WHEN EXISTS (
        SELECT 1
          FROM public._prisma_migrations
         WHERE finished_at IS NULL
           AND rolled_back_at IS NULL
       ) THEN 'yes' ELSE 'no' END" 2>/dev/null)" || return 1
  [[ "$open" == "no" ]] || return 1

  applied="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT migration_name
        FROM public._prisma_migrations
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL" 2>/dev/null)" || return 1
  applied=$'\n'"$applied"$'\n'
  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    name="${migration##*/}"
    [[ "$applied" == *$'\n'"$name"$'\n'* ]] || return 1
    if [[ "$name" == "20260801003400_gwg_fail_closed_and_destruction" ||
          "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_034=1
    fi
    if [[ "$name" == "20260801004300_gwg_identity_subjects_and_document_sets" ||
          "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_identity=1
    fi
    if [[ "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_044=1
    fi
  done <<< "$migrations"

  # `prisma migrate resolve --applied` schliesst nur das Journal und beweist
  # nicht, dass die DDL der fehlgeschlagenen Migration wirklich ausgefuehrt
  # wurde. Fuer Zielstaende ab 034 muessen deshalb auch deren DB-Schutzschichten
  # vollstaendig vorhanden sein; ab 043 gilt das zusaetzlich fuer die stabile
  # Subject-/Dokumentsatz-Zuordnung. Aeltere Releases behalten ihren damaligen
  # Vertrag und werden nicht nachtraeglich an spaetere Schemaobjekte gebunden.
  (( requires_gwg_034 == 0 )) || database_has_gwg_034_invariants || return 1
  (( requires_gwg_identity == 0 )) || database_has_gwg_identity_invariants || return 1
  (( requires_gwg_044 == 0 )) || database_has_gwg_044_invariants || return 1
}

can_retarget_recoverable_gwg_034_transition() {
  local existing_source="$1" existing_source_commit="$2"
  local existing_target="$3" existing_target_commit="$4"
  local source_version="$5" source_commit="$6" target_version="$7" target_commit="$8"
  local existing_requirement="${9:-unknown}" legacy_source=0

  [[ "$existing_source" == "$source_version" ]] || return 1
  if [[ -z "$existing_source_commit" && -z "$source_commit" ]]; then
    # Legacy-Lokalinstallationen vor Einfuehrung des Commit-Vertrags kennen den
    # Quell-Commit nicht. Sie duerfen nur vorwaerts fortgesetzt werden, wenn der
    # bestehende Marker jeden Ruecksprung bereits zwingend an einen DB-Restore
    # bindet; Ziel-Ancestry und DB-Zustand bleiben unten harte Beweise.
    [[ "$existing_requirement" == "true" ]] || return 1
    legacy_source=1
  else
    [[ "$existing_source_commit" == "$source_commit" && \
       "$existing_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  fi
  [[ "$existing_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  [[ -n "$existing_target" && -n "$target_version" ]] || return 1
  # Source-Kennungen wechseln absichtlich mit jedem Git-Commit; ihre Ordnung
  # beweist die Commit-Ancestry direkt darunter. Andere Tag-Wechsel muessen als
  # SemVer vergleichbar sein. Historische Nicht-SemVer-Tags bleiben nur bei
  # identischem Wert bestandskompatibel.
  if [[ "$existing_target" != "$target_version" ]]; then
    if [[ "$existing_target" =~ ^source-[0-9a-f]{12}$ && \
          "$target_version" =~ ^source-[0-9a-f]{12}$ ]]; then
      : # Commit-Ancestry ist unten das vollstaendige Ordnungs-Gate.
    else
      [[ "$existing_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
         "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
      semver_ge "$target_version" "$existing_target" || return 1
    fi
  fi
  git -C "$ROOT" merge-base --is-ancestor "$existing_target_commit" "$target_commit" \
    >/dev/null 2>&1 || return 1
  gwg_034_migration_is_fixed || return 1
  database_has_recoverable_gwg_034_failure && return 0
  # Nach einer kontrollierten manuellen Prisma-Recovery kann der exakte 42883-
  # Zustand bereits beseitigt sein, waehrend der Legacy-Marker die Aktivierung
  # weiterhin schuetzt. Dann muss das Journal geschlossen und der alte
  # Marker-Zielcommit vollstaendig angewendet sein. Erst spaeter hinzugekommene
  # Zielmigrationen duerfen anschliessend unter derselben Restore-Pflicht laufen.
  (( legacy_source == 1 )) || return 1
  database_is_fully_migrated_for_commit "$existing_target_commit"
}

begin_migration_transition() {
  local tmp source_version source_commit target_version target_commit requirement
  local existing_source existing_source_commit existing_target existing_target_commit existing_requirement
  assert_no_database_restore_pending
  source_version="$(state_value current)"
  source_commit="$(state_value current_commit)"
  if [[ -z "$source_commit" && \
        "${_TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT:-}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    # Legacy-State ohne current_commit: Nur der vor jedem Checkout-Wechsel
    # erfasste Start-Commit darf den neuen Vertrag vervollstaendigen. Bei einem
    # bereits vorhandenen Pending-Marker wird dieser Fallback nie gesetzt.
    source_commit="$_TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT"
  fi
  target_version="$(image_tag)"
  target_commit="${TAXTRONIK_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  requirement="$(pending_database_migration_requirement)"
  [[ "$requirement" == "true" || "$requirement" == "false" || "$requirement" == "unknown" ]] || \
    requirement="unknown"

  if [[ -f "$MIGRATION_PENDING" ]]; then
    existing_source="$(pending_migration_value source_version)"
    existing_source_commit="$(pending_migration_value source_commit)"
    existing_target="$(pending_migration_value target_version)"
    existing_target_commit="$(pending_migration_value target_commit)"
    existing_requirement="$(pending_migration_value requires_db_restore)"
    if [[ "$existing_source" != "$source_version" || \
          "$existing_source_commit" != "$source_commit" || \
          "$existing_target" != "$target_version" || \
          "$existing_target_commit" != "$target_commit" ]]; then
      if can_retarget_recoverable_gwg_034_transition \
        "$existing_source" "$existing_source_commit" \
        "$existing_target" "$existing_target_commit" \
        "$source_version" "$source_commit" "$target_version" "$target_commit" \
        "$existing_requirement"; then
        warn "Verifizierten GwG-Migrationsuebergang 03400 erkannt; Pending-Vertrag wird auf den sicheren Vorwaerts-Commit fortgeschrieben."
      else
        die "Migrations-Pending-Marker gehoert zu einem anderen Release-Uebergang (${existing_source:-Erstinstallation} -> ${existing_target:-unbekannt}) und wird nicht ueberschrieben. Erst bestehenden Fehlerzustand sicher aufloesen."
      fi
    fi
    requirement="$(merge_migration_restore_requirement "$existing_requirement" "$requirement")"
  fi

  tmp="$(mktemp "${MIGRATION_PENDING}.tmp.XXXXXX")" || \
    die "Migrations-Pending-Marker konnte nicht angelegt werden."
  {
    printf 'source_version=%s\n' "$source_version"
    printf 'source_commit=%s\n' "$source_commit"
    printf 'target_version=%s\n' "$target_version"
    printf 'target_commit=%s\n' "$target_commit"
    printf 'requires_db_restore=%s\n' "$requirement"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "Migrations-Pending-Marker konnte nicht gehaertet werden."; }
  mv -f "$tmp" "$MIGRATION_PENDING"
  chmod 0600 "$MIGRATION_PENDING" || die "Migrations-Pending-Marker konnte nicht gehaertet werden."
  info "Migrationsvertrag vorgemerkt (DB-Restore bei Ruecksprung: $requirement)."
}

clear_migration_transition() {
  [[ ! -e "$MIGRATION_PENDING" ]] || rm -f -- "$MIGRATION_PENDING"
}

write_database_restore_authorization() {
  local version="$1" status="$2" tmp
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Restore-Autorisierung braucht eine SemVer-Release-Version."
  [[ "$status" == "pending" || "$status" == "ready" ]] || \
    die "Restore-Autorisierung braucht einen gueltigen Status."
  tmp="$(mktemp "${DB_RESTORE_AUTHORIZATION}.tmp.XXXXXX")" || \
    die "DB-Restore-Autorisierung konnte nicht angelegt werden."
  {
    printf 'target_version=%s\n' "$version"
    printf 'status=%s\n' "$status"
    printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "DB-Restore-Autorisierung konnte nicht gehaertet werden."; }
  mv -f "$tmp" "$DB_RESTORE_AUTHORIZATION"
  chmod 0600 "$DB_RESTORE_AUTHORIZATION" || die "DB-Restore-Autorisierung konnte nicht gehaertet werden."
}

begin_database_restore_authorization() {
  local version="$1"
  # Vor der ersten moeglichen Restore-Seitenauswirkung persistieren. Bleibt der
  # Restore teilweise oder vollstaendig erfolglos, blockiert `pending` jeden
  # spaeteren Writer-Start bis zu einem erneut erfolgreichen Restore.
  write_database_restore_authorization "$version" pending
  # Die wiederhergestellte Datenbank liegt per Definition vor dem zuvor
  # vorgemerkten Migrationsversuch; dessen Marker darf nicht weiter blockieren.
  clear_migration_transition
}

authorize_database_restore_release() {
  local version="$1" existing_target existing_status
  existing_target="$(database_restore_authorized_target)"
  existing_status="$(database_restore_authorization_status)"
  [[ "$existing_target" == "$version" && "$existing_status" == "pending" ]] || \
    die "Restore-Autorisierung kann nicht finalisiert werden: passender Pending-Marker fehlt."
  write_database_restore_authorization "$version" ready
}

database_restore_authorized_target() {
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  grep -E '^target_version=' "$DB_RESTORE_AUTHORIZATION" | head -n1 | cut -d= -f2- || true
}

database_restore_authorization_status() {
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  grep -E '^status=' "$DB_RESTORE_AUTHORIZATION" | head -n1 | cut -d= -f2- || true
}

clear_database_restore_authorization() {
  [[ ! -e "$DB_RESTORE_AUTHORIZATION" ]] || rm -f -- "$DB_RESTORE_AUTHORIZATION"
}

# Schreibt den vollstaendigen Last-Good-Artefaktvertrag fuer Rollback.
# `previous` ist der zuvor erfolgreiche current-Stand; ein fehlgeschlagener
# Deploy erreicht diese Funktion nie und kann den Last-Good-Zeiger nicht
# ueberschreiben.
save_state() {
  local tmp new_version new_web new_worker new_commit new_restore_requirement
  local old_current old_web old_worker old_commit old_restore_requirement
  local previous previous_web previous_worker previous_commit
  new_version="$(image_tag)"
  new_web="${TAXTRONIK_WEB_DIGEST_SUFFIX:-}"
  new_worker="${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}"
  new_commit="${TAXTRONIK_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  old_current="$(state_value current)"
  old_web="$(state_value current_web_digest_suffix)"
  old_worker="$(state_value current_worker_digest_suffix)"
  old_commit="$(state_value current_commit)"
  old_restore_requirement="$(state_value current_rollback_requires_db_restore)"
  [[ "$old_restore_requirement" == "true" || "$old_restore_requirement" == "false" ]] || \
    old_restore_requirement="unknown"

  if [[ "$new_version" == "$old_current" && "$new_web" == "$old_web" && \
        "$new_worker" == "$old_worker" && "$new_commit" == "$old_commit" ]]; then
    # Ein idempotenter Redeploy darf den echten N-1-Rollbackzeiger nicht durch
    # current=current zerstoeren.
    previous="$(state_value previous)"
    previous_web="$(state_value previous_web_digest_suffix)"
    previous_worker="$(state_value previous_worker_digest_suffix)"
    previous_commit="$(state_value previous_commit)"
    # Der Stand selbst und sein echter N-1-Zeiger ändern sich nicht.
    new_restore_requirement="$old_restore_requirement"
  else
    previous="$old_current"
    previous_web="$old_web"
    previous_worker="$old_worker"
    previous_commit="$old_commit"
    new_restore_requirement="${TAXTRONIK_ROLLBACK_REQUIRES_DB_RESTORE:-$(pending_migration_value requires_db_restore)}"
    [[ "$new_restore_requirement" == "true" || "$new_restore_requirement" == "false" ]] || \
      new_restore_requirement="unknown"
  fi

  # Nach einem Produktions-DB-Restore ist nur die eben autorisierte ältere
  # Version mit dem restaurierten Schema bewiesen. Der automatisch entstehende
  # Rückweg zu `previous` (typischerweise neuerer Code) braucht mindestens
  # Migrationen und darf niemals als kompatibler Rollback markiert werden.
  # Der Restore-Marker bleibt bis nach save_state bestehen und macht diesen
  # Reverse-Pfad deshalb bewusst fail-closed.
  if [[ -e "$DB_RESTORE_AUTHORIZATION" ]]; then
    new_restore_requirement="unknown"
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
    printf 'current_rollback_requires_db_restore=%s\n' "$new_restore_requirement"
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
  clear_migration_transition
  clear_database_restore_authorization
  rm -f -- "$INSTALL_PENDING"
}

# ---------------------------------------------------------------------------
# .env-Vorbereitung (deploy/update). Stellt sicher, dass der Server
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

# Interaktive .env-Vorbereitung fuer deploy/update.
prepare_env_interactive() {
  local env_created="${_TAXTRONIK_ENV_CREATED_THIS_RUN:-0}" deploy_channel=""
  if [[ ! -f "$ENVFILE" ]]; then
    info ".env fehlt — aus Vorlage anlegen"
    [[ -f "$ROOT/.env.example" ]] || die ".env.example fehlt."
    cp "$ROOT/.env.example" "$ENVFILE"
    env_created=1
  fi
  chmod 0600 "$ENVFILE" || die "Dateirechte fuer $ENVFILE konnten nicht auf 0600 gesetzt werden."
  deploy_channel="$(deployment_channel 2>/dev/null || true)"
  [[ "$deploy_channel" == "source" || "$deploy_channel" == "release" ]] || \
    die "TAXTRONIK_DEPLOY_CHANNEL muss source oder release sein."
  set_env TAXTRONIK_DEPLOY_CHANNEL "$deploy_channel"
  if [[ "$deploy_channel" == "source" ]]; then
    set_env TAXTRONIK_IMAGE_PREFIX taxtronik
    set_env TAXTRONIK_VERSION "$(source_version_for_checkout)"
  fi
  # Prod-Default (NODE_ENV, TAXTRONIK_VERSION) + fehlende Secrets generieren.
  doctor --fix >/dev/null || true
  # Nur bei einer soeben neu angelegten Installation automatisch trennen.
  # Bei Legacy-Daten würde ein neuer Box-Key bestehende Ciphertexte unlesbar
  # machen; dort ist zuerst ein kontrollierter Re-Wrap erforderlich.
  [[ $env_created -eq 1 ]] && ensure_secret SECRET_BOX_KEY 32
  bake_db_urls_into_env

  # Nur veröffentlichte Releases brauchen eine manuell gewählte SemVer. Source
  # ist bereits oben automatisch an den exakten Git-Commit gebunden.
  if [[ "$deploy_channel" == "release" && -z "$(get_env TAXTRONIK_VERSION)" ]]; then
    if [[ -t 0 ]]; then
      local release_version=""
      while :; do
        read -rp "Veroeffentlichte Release-Version (SemVer X.Y.Z): " release_version || true
        [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
        warn "Bitte den exakten Tag eines veroeffentlichten Releases eingeben."
      done
      set_env TAXTRONIK_VERSION "$release_version"
    else
      warn "TAXTRONIK_VERSION fehlt (kein TTY) — explizit auf einen Release setzen."
    fi
  fi

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

  configure_n8n_domain_interactive

  configure_risk_layer_interactive

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

# Das integrierte Setup darf nicht nur den n8n-Container und seine öffentliche
# Domain starten: Es muss die verwaltete Instanz auch tenantgebunden im ACP
# hinterlegen. Der DB-Schritt ist create-only und lässt jede bestehende bzw.
# migrierte Betreiber-Konfiguration unangetastet.
ensure_managed_n8n_connection() {
  [[ -n "${N8N_HOST:-}" ]] || return 0
  generate_prisma_client_for_host_tools
  ( cd "$ROOT" && pnpm --filter @taxtronik/db provision:n8n ) \
    || die "Verwaltete n8n-Verbindung konnte nicht im ACP provisioniert werden."
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

# Gemeinsame Deploy-Sequenz. Enthaelt die Erstinstall-Erkennung, sodass deploy
# eine frische Installation komplett abdeckt.
_deploy_core() {
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
  assert_no_database_restore_pending
  ensure_host_tool_deps
  prepare_release_contract
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  provide_traefik_for_deploy
  provide_signal_for_deploy deploy
  backup_before_migrations
  run_migrations
  ensure_provisioned_interactive
  ensure_managed_n8n_connection
  start_signal_for_deploy || die "Deploy abgebrochen: verwaltetes Signal ist nicht bereit."
  start_apps_for_activation deploy "$(image_tag)"
  smoke_health || die "Deploy abgebrochen: Anwendung ist nicht vollstaendig healthy."
  smoke_public_frontend || die "Deploy abgebrochen: verwaltetes Traefik/TLS ist nicht oeffentlich bereit."
  deploy_readiness || die "Deploy abgebrochen: Produktivkonfiguration ist nicht bereit."
  finalize_release_contract
}

# ---------------------------------------------------------------------------
# Operator-Kommandos (aufgerufen vom Dispatcher ./taxtronik)
# ---------------------------------------------------------------------------
cmd_config() {
  if [[ -f "$ENVFILE" ]]; then
    info "Konfiguration ist bereits vorhanden: $ENVFILE"
    info "Validierung/Auffuellen: ./taxtronik doctor --fix"
    return 0
  fi
  [[ -t 0 ]] || die "Initialkonfiguration braucht ein interaktives Terminal."
  configure_initial_deployment_interactive
  info "Konfiguration gespeichert. Mit './taxtronik deploy' wird sie angewendet."
}

cmd_deploy() {
  configure_initial_deployment_interactive
  ensure_bootstrap_host_requirements
  prepare_env_interactive
  _deploy_core
  info "Deploy fertig. Version: $(image_tag)"
  cat <<EOF

=================================================================
  Deployment abgeschlossen. Version: $(image_tag)
=================================================================
  Staff-Login : (NEXTAUTH_URL aus .env)/staff/login
  n8n-Setup   : https://${N8N_HOST:-nicht-konfiguriert}/ (Owner anlegen, API-Key erzeugen)
                Danach den Key im ACP unter Einstellungen -> n8n eintragen.
  Admin-Zugang: siehe $ROOT/.admin-credentials.txt (falls neu angelegt)
                Nach erstem Login + TOTP-Setup die Datei sicher loeschen.

  Naechste Schritte:
    ./taxtronik doctor     # Konfiguration pruefen
    ./taxtronik logs app   # Logs ansehen
    ./taxtronik update     # Updates einspielen
EOF
}

cmd_update() {
  require_cmd docker; require_cmd node; require_cmd curl; require_cmd git
  local _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT=""

  # Vor dem ersten Forward-Versuch kann ein Legacy-State noch keinen Commit
  # enthalten. Den aktuellen Checkout nur ohne bestehenden Pending-Vertrag als
  # Quellbeweis erfassen; bei Retries bleibt der persistierte Marker massgeblich.
  if [[ ! -e "$MIGRATION_PENDING" ]]; then
    _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi

  # Das Pflichtbackup muss vollstaendig mit dem bisher installierten Checkout
  # und dessen Prisma-Client laufen. Neuer Anwendungscode darf das noch alte
  # DB-Schema vor dessen Migration nicht abfragen. Erst ein erfolgreiches
  # Backup autorisiert daher ueberhaupt fetch/merge und damit eine Aenderung des
  # Arbeitsbaums.
  prepare_env_interactive
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
  assert_no_database_restore_pending
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
    # Der globale umask 077 schuetzt Operator-Secrets, darf aber von Git neu
    # angelegte getrackte Quellen nicht auf 0600/0700 beschraenken: Docker COPY
    # wuerde diese Modi sonst in die non-root-Runtime-Images uebernehmen.
    (umask 022; git merge --ff-only "$UPDATE_COMMIT_SHA")
  else
    git fetch "$remote"
    target_ref="${TAXTRONIK_UPDATE_REF:-$remote/main}"
    (umask 022; git merge --ff-only "$target_ref")
  fi
  # package.json/Workspace-Exports des neuen Checkouts muessen vor jedem
  # weiteren Host-pnpm-Kommando in node_modules gespiegelt sein. Andernfalls
  # blockiert `verifyDepsBeforeRun: error` erst spaet im Readiness-Gate.
  ensure_host_tool_deps
  # .env ggfs. aus dem aktualisierten Stand neu vervollstaendigen (Prod-Defaults,
  # fehlende Secrets, NEXTAUTH_URL) — wie bei deploy ohne Hand-Editiererei.
  prepare_env_interactive
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
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
  provide_traefik_for_deploy
  provide_signal_for_deploy update
  run_migrations
  start_signal_for_deploy || die "Update abgebrochen: verwaltetes Signal ist nicht bereit."
  start_apps_for_activation deploy "$(image_tag)"
  smoke_health || die "Update fehlgeschlagen: Anwendung ist nicht vollstaendig healthy; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  smoke_public_frontend || die "Update fehlgeschlagen: verwaltetes Traefik/TLS ist nicht oeffentlich bereit; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
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
  if ! run_backup "$staging/database"; then
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
  if [[ -f "$target/volumes/traefik-acme.tar.gz" ]]; then
    tar -tzf "$target/volumes/traefik-acme.tar.gz" >/dev/null
  fi
  info "Entschluesselung + Archiv-Strukturpruefung erfolgreich. Restore ausschliesslich nach DR-Runbook auf isoliertem Ziel fortsetzen."
}

cmd_backup_offsite() {
  local dest="${1:-}"
  [[ -n "$dest" && -d "$dest" ]] || die "Nutzung: ./taxtronik backup-offsite <full-backup-verzeichnis>"
  load_env
  cmd_backup_verify "$dest"
  upload_full_backup_offsite "$dest"
}

assert_restore_writers_stopped() {
  local container running
  for container in taxtronik-app taxtronik-worker taxtronik-n8n; do
    running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)"
    [[ "$running" != "true" ]] || die "Produktions-Restore verweigert: $container laeuft weiterhin."
  done
}

cmd_restore() {
  local restore_rc=0
  # Muss vor load_env/preflight/start_infra laufen: fehlerhafte oder
  # widerspruechliche Argumente duerfen keinerlei Betriebszustand veraendern.
  validate_restore_args "$@"
  load_env; preflight_common; assert_production_env
  unset TAXTRONIK_PRODUCTION_RESTORE_QUIESCED

  if [[ "$RESTORE_LIST_ONLY" == "1" ]]; then
    run_restore "$@" || { restore_rc=$?; return "$restore_rc"; }
    info "Restore-Liste gelesen (read-only)."
    return 0
  fi

  if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
    begin_database_restore_authorization "$RESTORE_RELEASE_VERSION"
    warn "PRODUKTIONS-RESTORE: App, Worker und n8n werden jetzt quiesziert und bleiben auch nach Erfolg/Fehler gestoppt."
    compose stop app worker n8n || die "Schreibdienste konnten vor dem Produktions-Restore nicht vollstaendig gestoppt werden."
    assert_restore_writers_stopped
    export TAXTRONIK_PRODUCTION_RESTORE_QUIESCED=1
  fi

  start_infra
  wait_postgres_healthy
  if restore_needs_s3 "$@"; then
    wait_seaweedfs_healthy
  fi
  sync_postgres_roles_from_env

  run_restore "$@" || {
    restore_rc=$?
    if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
      warn "Produktions-Restore fehlgeschlagen (Exit $restore_rc). App, Worker und n8n bleiben zur sicheren Diagnose gestoppt."
    fi
    return "$restore_rc"
  }
  if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
    authorize_database_restore_release "$RESTORE_RELEASE_VERSION"
    warn "Produktions-Restore fertig. App, Worker und n8n bleiben absichtlich gestoppt; passenden Release-Vertrag pruefen und erst danach starten."
  else
    info "Restore in explizites Ziel fertig."
  fi
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
    (umask 022; git -C "$ROOT" switch "$_TAXTRONIK_ROLLBACK_SOURCE_BRANCH") >/dev/null 2>&1
  else
    (umask 022; git -C "$ROOT" switch --detach "$restore_commit") >/dev/null 2>&1
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
    # In einer Subshell ausfuehren, weil der zentrale Guard bewusst via `die`
    # fail-closed beendet. Ist Last-Good nach Restore/Migration nicht mehr
    # autorisiert, werden auch bereits teilweise gestartete Ziel-Writer
    # gestoppt, statt sie nach der fehlgeschlagenen Aktivierung weiterlaufen zu
    # lassen.
    if ! ( start_apps_for_activation rollback "$_TAXTRONIK_ROLLBACK_LAST_GOOD_VERSION" ); then
      warn "Automatischer Last-Good-Containerstart fehlgeschlagen; Writer werden gestoppt und .env/STATE bleiben unveraendert."
      compose stop app worker n8n || \
        warn "Writer konnten nach fehlgeschlagener Rollback-Aktivierung nicht vollstaendig gestoppt werden."
    fi
  fi
  exit "$rc"
}

assert_rollback_database_compatible() {
  local target="$1" current="$2" previous="$3" current_requirement="$4"
  local pending_requirement pending_source restored_target restored_status

  if [[ -f "$DB_RESTORE_AUTHORIZATION" && -f "$MIGRATION_PENDING" ]]; then
    die "Rollback blockiert: DB-Restore- und Migrations-Pending-Marker existieren gleichzeitig. Markerzustand vor jeder Aktivierung klaeren."
  fi

  if [[ -f "$DB_RESTORE_AUTHORIZATION" ]]; then
    restored_target="$(database_restore_authorized_target)"
    restored_status="$(database_restore_authorization_status)"
    [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
      die "Rollback blockiert: DB-Restore-Autorisierung ist ungueltig."
    [[ "$restored_status" == "ready" ]] || \
      die "Rollback blockiert: Produktions-DB-Restore ist nicht erfolgreich finalisiert (Status: ${restored_status:-ungueltig})."
    [[ "$target" == "$restored_target" ]] || \
      die "Rollback blockiert: Die restaurierte Produktions-DB ist ausschliesslich fuer Release $restored_target autorisiert."
    warn "Rollback-Ziel $target ist durch den unmittelbar vorherigen Produktions-DB-Restore autorisiert."
    return 0
  fi

  if [[ -f "$MIGRATION_PENDING" ]]; then
    pending_requirement="$(pending_migration_value requires_db_restore)"
    pending_source="$(pending_migration_value source_version)"
    [[ "$pending_requirement" == "false" ]] || \
      die "Rollback blockiert: Ein nicht finalisierter Migrationslauf kann das Schema vorwaerts veraendert haben (Status: ${pending_requirement:-unknown}). Vor-Migrations-Backup wiederherstellen oder den Ziel-Release vorwaerts reparieren."
    [[ -n "$pending_source" && "$target" == "$pending_source" ]] || \
      die "Rollback blockiert: Nach einer abgebrochenen Aktivierung ohne DB-Migration ist nur der vorgemerkte Quellstand '$pending_source' zulaessig."
    return 0
  fi

  # current ist keine Code-Rueckstufung, sondern nur Recovery eines
  # abweichenden .env-/Prozessvertrags.
  [[ "$target" == "$current" ]] && return 0
  [[ -n "$previous" && "$target" == "$previous" ]] || \
    die "Rollback blockiert: Ohne verifizierten State oder passende DB-Restore-Autorisierung ist nur das exakt gespeicherte previous-Ziel zulaessig."
  [[ "$current_requirement" == "false" ]] || \
    die "Rollback blockiert: Kompatibilitaet des aktuellen DB-Schemas mit previous ist '${current_requirement:-unknown}'. Vor-Migrations-Backup wiederherstellen statt alten Code zu starten."
}

assert_database_restore_rollback_request() {
  local requested="$1" restored_target restored_status
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  restored_target="$(database_restore_authorized_target)"
  restored_status="$(database_restore_authorization_status)"
  [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Rollback blockiert: DB-Restore-Autorisierung ist ungueltig."
  [[ "$restored_status" == "ready" ]] || \
    die "Rollback blockiert: Produktions-DB-Restore ist nicht erfolgreich finalisiert (Status: ${restored_status:-ungueltig})."
  [[ -n "$requested" ]] || \
    die "Nach Produktions-DB-Restore ist die Zielversion Pflicht: ./taxtronik rollback $restored_target"
  [[ "$requested" == "$restored_target" ]] || \
    die "Rollback blockiert: explizit angefordert wurde '$requested', restauriert und autorisiert ist ausschliesslich '$restored_target'."
}

# Rollback auf einen frueheren Artefakt- UND Code-Stand. KEINE DB-Migration
# (Prisma ist forward-only) — Schema-Aenderungen bleiben zurueck. Bei einem
# zuvor fehlgeschlagenen Update zeigt .env auf einen Pending-Stand; ohne
# Argument wird dann bewusst state.current (Last-Good) statt N-1 aktiviert.
cmd_rollback() {
  require_cmd docker; require_cmd node; require_cmd curl; require_cmd git
  load_env; preflight_common; assert_production_env
  local requested="${1:-}" target="" state_target="" state_web="" state_worker="" state_commit=""
  local current current_web current_worker current_commit current_restore_requirement
  local previous previous_web previous_worker previous_commit
  local env_matches_current=0 prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" img registry_mode=0
  assert_database_restore_rollback_request "$requested"
  [[ -f "$STATE" ]] || die "Kein verifizierter Release-State in $STATE; Rollback wird verweigert."
  current="$(state_value current)"
  current_web="$(state_value current_web_digest_suffix)"
  current_worker="$(state_value current_worker_digest_suffix)"
  current_commit="$(state_value current_commit)"
  current_restore_requirement="$(state_value current_rollback_requires_db_restore)"
  [[ "$current_restore_requirement" == "true" || "$current_restore_requirement" == "false" ]] || \
    current_restore_requirement="unknown"
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

  # Vor Manifest-Auflösung, Pull, Checkout-Wechsel oder Containerstart prüfen.
  assert_rollback_database_compatible \
    "$target" "$current" "$previous" "$current_restore_requirement"

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
  (umask 022; git -C "$ROOT" switch --detach "$state_commit")
  export _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED=1
  ensure_host_tool_deps

  warn "Rollback auf $target — DB-Kompatibilitaet wurde fail-closed aus dem Release-State bestaetigt."
  start_apps_for_activation rollback "$target"
  smoke_health || die "Rollback-Container sind gestartet, aber nicht healthy."
  smoke_public_frontend || die "Rollback-Container laufen, aber verwaltetes Traefik/TLS ist nicht oeffentlich bereit."
  deploy_readiness || die "Rollback-Container sind gestartet, aber die Produktivkonfiguration ist nicht bereit."

  # Die Aktivierung ist fachlich erfolgreich. Ab hier keinen automatischen
  # Ruecksprung mehr; STATE/.env werden als neuer Last-Good-Stand verankert.
  trap - EXIT INT TERM
  export TAXTRONIK_ROLLBACK_REQUIRES_DB_RESTORE=false
  finalize_release_contract
  unset TAXTRONIK_ROLLBACK_REQUIRES_DB_RESTORE
  unset _TAXTRONIK_ROLLBACK_CHECKOUT_CHANGED
  info "Rollback fertig. Version: $target"
}

# Historischer Alias. Neue Installationen und bestehende Systeme verwenden
# denselben vollstaendigen Hauptweg `deploy`.
cmd_bootstrap() {
  warn "'./taxtronik bootstrap' ist nur noch ein Kompatibilitaetsalias. Bitte kuenftig './taxtronik deploy' verwenden."
  cmd_deploy "$@"
}
