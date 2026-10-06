#!/usr/bin/env bash
# =============================================================================
# Deployment-Oberflaeche — Teil der Operator-CLI (./taxtronik).
#
# DEPLOYMENT_METHOD, Domain-/E-Mail-Validierung, dynamische Traefik-Routen,
# Traefik-Image fuer den Deploy und oeffentlicher HTTPS-Smoke.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
  # shellcheck disable=SC2016 # Backticks sind Traefik-Regelsyntax, keine Kommandosubstitution
  {
    printf 'http:\n'
    printf '  middlewares:\n'
    printf '    taxtronik-app-body-limit:\n'
    printf '      buffering:\n'
    printf '        maxRequestBodyBytes: 27262976\n'
    printf '        memRequestBodyBytes: 1048576\n'
    printf '    taxtronik-login-body-limit:\n'
    printf '      buffering:\n'
    printf '        maxRequestBodyBytes: 65536\n'
    printf '        memRequestBodyBytes: 65536\n'
    printf '  routers:\n'
    printf '    taxtronik-staff-password-login:\n'
    printf '      rule: "Host(`%s`) && Path(`/staff/login/password`)"\n' "$staff_host"
    printf '      priority: 100\n'
    printf '      entryPoints: [websecure]\n'
    printf '      middlewares: [taxtronik-login-body-limit]\n'
    printf '      service: taxtronik-app\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '    taxtronik-staff-login-action:\n'
    printf '      rule: "Host(`%s`) && Path(`/staff/login`) && Method(`POST`)"\n' "$staff_host"
    printf '      priority: 110\n'
    printf '      entryPoints: [websecure]\n'
    printf '      middlewares: [taxtronik-login-body-limit]\n'
    printf '      service: taxtronik-app\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '    taxtronik-staff:\n'
    printf '      rule: "Host(`%s`)"\n' "$staff_host"
    printf '      entryPoints: [websecure]\n'
    printf '      middlewares: [taxtronik-app-body-limit]\n'
    printf '      service: taxtronik-app\n'
    printf '      tls:\n'
    printf '        certResolver: letsencrypt\n'
    printf '    taxtronik-portal:\n'
    printf '      rule: "Host(`%s`)"\n' "$portal_host"
    printf '      entryPoints: [websecure]\n'
    printf '      middlewares: [taxtronik-app-body-limit]\n'
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

provide_traefik_for_deploy() {
  [[ "$(deployment_method)" == "traefik" ]] || return 0
  info "Digest-gepinntes Traefik-Image beziehen"
  compose pull traefik || die "Traefik-Image konnte nicht bezogen werden."
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
