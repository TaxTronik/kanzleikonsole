#!/usr/bin/env bash
# =============================================================================
# .env lesen, schreiben und vervollstaendigen — Teil der Operator-CLI (./taxtronik).
#
# load_env/get_env/set_env/ensure_secret sowie die interaktive Vorbereitung
# fuer deploy/update (prepare_env_interactive, SMTP-, Cookie-Domain- und
# n8n-Domain-Abfragen).
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
# get_env/set_env bleiben Bash: `./taxtronik deploy` schreibt die .env
# (Initialplan) bereits, bevor der 1-Klick-Pfad Node.js installiert. Setup- und
# Startskripte nutzen scripts/env-tool.mjs mit demselben Verhalten
# (Paritaetstest in scripts/tests/env-tool.test.mjs).
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

# Fuellt nur leere Secrets. Bekannte Dev-/CI-Defaults (dieselbe Liste wie das
# Prod-Gate in @taxtronik/config, via scripts/env-tool.mjs) werden gemeldet,
# aber nicht ersetzt: DB-/n8n-Zugaenge liegen auch in bestehenden Volumes und
# AUTH_SECRET kann Legacy-Secret-Box-Ciphertexte schuetzen.
ensure_secret() {
  local key="$1" bytes="$2"
  if [[ -z "$(get_env "$key")" ]]; then
    set_env "$key" "$(rand_b64 "$bytes")"
    info "$key generiert."
  elif command -v node >/dev/null 2>&1 && \
      [[ "$(node "$ROOT/scripts/env-tool.mjs" weak "$ENVFILE" "$key" 2>/dev/null || true)" == "weak" ]]; then
    warn "$key ist ein bekannter Dev-/CI-Default, den die App in Produktion ablehnt; kontrolliert rotieren (docs/operations/secret-rotation.md)."
  fi
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
  # B4: Einseitige Cookie-Domains sind wie im App-Schema nur eine Warnung (beide
  # Surfaces teilen sich dann den Hostnamen); die uebrigen Regeln entfallen dann.
  if [[ -z "$staff_dom" || -z "$portal_dom" ]]; then
    warn "STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN sind nur einseitig gesetzt: keine Cookie-Trennung zwischen Kanzlei- und Mandantenportal. Beide setzen oder beide leeren."
    return 0
  fi
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
  # Das doctor-Gate prueft hier nur die Konfiguration. Den Live-Zustand der
  # DB-Rollen und Container (S-01) stellt der Ablauf erst danach her.
  local _TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1
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
