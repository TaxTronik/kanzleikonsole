#!/usr/bin/env bash
# =============================================================================
# Host-Provisionierung und Erstinstallation — Teil der Operator-CLI (./taxtronik).
#
# 1-Klick-Installation (Basispakete, Docker, Node, pnpm), Leerhost-Gate,
# Install-Pending-Marker, Initialsetup (./taxtronik config) sowie Tenant-/
# Admin- und n8n-Provisionierung.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
  if [[ "$_SETUP_DEPLOY_CHANNEL" == "release" ]]; then
    set_env UPDATE_MANIFEST_URL "$TAXTRONIK_UPDATE_MANIFEST_URL_DEFAULT"
    set_env UPDATE_PUBLIC_KEY "$TAXTRONIK_UPDATE_PUBLIC_KEY_DEFAULT"
  fi
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
  if [[ "$_SETUP_SIGNAL_MODE" == "managed" ]]; then
    set_env SIGNAL_LLM_DIR "$ROOT/.taxtronik/signal-llm"
    set_env RISK_LAYER_LLM_BACKEND cpu
    set_env RISK_LAYER_LLM_TIMEOUT "$SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT"
  else
    set_env SIGNAL_LLM_DIR ""
    set_env RISK_LAYER_LLM_BACKEND auto
    set_env RISK_LAYER_LLM_TIMEOUT ""
  fi
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
        warn "Bitte den exakten Tag eines veroeffentlichten Releases eingeben, z. B. 0.2.1."
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
  # shellcheck disable=SC2015 # gewollt: die, sobald eine der beiden Pruefungen scheitert
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
      printf '  1) Festen Signal-Git-Stand lokal bauen (derzeit empfohlen)\n'
      printf '     Klont Signal auf den gewaehlten Commit und baut ein CPU-Image ohne automatischen Indexaufbau.\n'
      printf '     Enthalten: Signal-Kern, Embeddings, Quantenextras und lokale LLM-Vertiefung.\n'
      printf '     CPU-Hinweis: Das gepinnte 8B-Modell (~6,25 GB) ist ein deutlicher Performance-Bottleneck.\n'
      printf '  2) Veroeffentlichtes Container-Image aus einer Registry\n'
      printf '     Nur waehlen, wenn das versionierte Image tatsaechlich veroeffentlicht ist.\n'
      read -rp 'Auswahl [1]: ' choice || true
      case "${choice:-1}" in
        1|source)
          _SETUP_SIGNAL_CHANNEL="source"
          read -rp "Signal-Git-Repository [$_SETUP_SIGNAL_GIT_URL]: " input || true
          _SETUP_SIGNAL_GIT_URL="${input:-$_SETUP_SIGNAL_GIT_URL}"
          valid_signal_git_url "$_SETUP_SIGNAL_GIT_URL" || die "Signal-Git-URL ist ungueltig oder enthaelt Zugangsdaten."
          # Kein impliziter beweglicher Branch: Der Ref muss ausdruecklich
          # gewaehlt werden (Commit-SHA empfohlen, siehe SIGNAL_GIT_REF_DEFAULT).
          while :; do
            read -rp "Signal-Git-Ref (vollstaendiger Commit-SHA empfohlen, alternativ refs/tags/<Tag>)${_SETUP_SIGNAL_GIT_REF:+ [$_SETUP_SIGNAL_GIT_REF]}: " input || \
              die "Initialsetup ohne Signal-Git-Ref abgebrochen."
            input="${input:-$_SETUP_SIGNAL_GIT_REF}"
            if valid_signal_git_ref "$input"; then _SETUP_SIGNAL_GIT_REF="$input"; break; fi
            warn "Signal-Git-Ref fehlt oder ist ungueltig; bitte einen vollstaendigen Commit-SHA oder refs/tags/<Tag> angeben."
          done
          [[ "$(signal_git_ref_kind "$_SETUP_SIGNAL_GIT_REF")" != "moving" ]] || \
            warn "'$_SETUP_SIGNAL_GIT_REF' ist beweglich: Jedes Update baut dann den jeweils neuesten Signal-Stand. Commit-SHA empfohlen."
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
    printf 'LLM        : %s, CPU-only (funktionsfaehig; deutlicher Performance-Bottleneck)\n' \
      "$SIGNAL_MANAGED_LLM_MODEL"
  elif [[ "$_SETUP_SIGNAL_MODE" == "managed" ]]; then
    printf 'Signal     : verwaltet, Registry-Image %s\n' "$_SETUP_SIGNAL_IMAGE"
    printf 'LLM        : %s, CPU-only (funktionsfaehig; deutlicher Performance-Bottleneck)\n' \
      "$SIGNAL_MANAGED_LLM_MODEL"
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
