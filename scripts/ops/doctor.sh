#!/usr/bin/env bash
# =============================================================================
# ./taxtronik doctor — Teil der Operator-CLI (./taxtronik).
#
# .env-Validierung mit OK/FEHLT/SCHWACH/WARN/INFO-Zeilen inklusive DB-Pool-Summe,
# Datenbankrollen der Container (S-01), n8n-Volume-Key, Source-Update-Signaturen
# (S-04) und den Befunden des App-Schemas aus dem Worker-Image (B-05).
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

# doctor-Zeilen zum S-04-Zustand des Source-Kanals ausserhalb von Produktion
# (in Produktion meldet doctor den Source-Kanal selbst als FEHLT). Fehlende
# Signer sind dort nur WARN; FEHLT gilt fuer eine konfigurierte, aber
# unbrauchbare Signer-Datei.
_doctor_source_update_trust() {
  local signers="" signers_rc=0
  signers="$(source_allowed_signers_file)" || signers_rc=$?
  case "$signers_rc" in
    0)
      if command -v ssh-keygen >/dev/null 2>&1; then
        _dr_row "OK" "SOURCE_UPDATE_SIGNERS" "$signers (SSH-Signatur vor jedem Update Pflicht)"
      else
        _dr_row "WARN" "SOURCE_UPDATE_SIGNERS" "$signers, aber ssh-keygen fehlt (openssh-client): Update wird verweigert"
        _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
      fi
      ;;
    2)
      _dr_row "FEHLT" "SOURCE_UPDATE_SIGNERS" "$signers"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      ;;
    *)
      _dr_row "WARN" "SOURCE_UPDATE_SIGNERS" "fehlen; ausserhalb Produktion nur Warnung"
      _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
      ;;
  esac
}

# Das fruehere Opt-out fuer ungepruefte Source-Updates wirkt in keinem Kanal
# mehr. Ein gesetzter Wert ist nur ein Ueberbleibsel: WARN, nie FEHLT.
_doctor_obsolete_unsigned_opt_out() {
  [[ -n "${TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE:-}" ]] || return 0
  _dr_row "WARN" "TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE" "wirkungslos, entfernen"
  _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
}

# B-05 (c): Liegt das konfigurierte Worker-Image lokal vor, zeigt doctor die
# Befunde seiner Konfigurationspruefung (dasselbe Schema, mit dem web und
# worker starten; run_app_env_check). Sonst genuegt eine INFO-Zeile, denn
# deploy/update pruefen im Ziel-Image vor Backup und Migration. Das interne
# Konfigurations-Gate von deploy/update startet hier keinen Container: Dort
# folgt die Pruefung mit dem Ziel-Image ohnehin.
_doctor_app_env_schema() {
  local image output="" status=0 line key row_status detail failed_rows=0
  image="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/worker:${TAXTRONIK_VERSION:-dev}${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}"
  if [[ "${_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY:-0}" == "1" ]]; then
    _dr_row "INFO" "SCHEMA" "deploy/update pruefen die App-Konfiguration im Ziel-Image vor Backup und Migration"
    return 0
  fi
  # Sonde: fehlt Docker oder das Image, gibt es hier nichts zu pruefen.
  if ! command -v docker >/dev/null 2>&1 || ! docker image inspect "$image" >/dev/null 2>&1; then
    _dr_row "INFO" "SCHEMA" "$image nicht lokal; deploy/update pruefen die App-Konfiguration vor Backup und Migration"
    return 0
  fi
  # Subshell: ein `die` des Compose-Wrappers wird zur FEHLT-Zeile statt doctor zu beenden.
  output="$( (run_app_env_check) 2>&1 )" || status=$?
  while IFS= read -r line; do
    if [[ "$line" =~ ^\ \ (FEHLT|WARN|OK)\ +(SCHEMA_(WEB|WORKER))\ +(.*)$ ]]; then
      row_status="${BASH_REMATCH[1]}"; key="${BASH_REMATCH[2]}"; detail="${BASH_REMATCH[4]}"
      _dr_row "$row_status" "$key" "$detail"
      case "$row_status" in
        FEHLT) _DOCTOR_ERRS=$((_DOCTOR_ERRS+1)); failed_rows=$((failed_rows+1)) ;;
        WARN) _DOCTOR_WARNS=$((_DOCTOR_WARNS+1)) ;;
      esac
    elif [[ -n "$line" ]]; then
      printf '           %s\n' "$line"
    fi
  done <<<"$output"
  # Fehlschlag ohne eigene FEHLT-Zeile: Pruefung lief nicht (Compose, Image).
  if (( status != 0 && failed_rows == 0 )); then
    _dr_row "FEHLT" "SCHEMA" "Pruefung im Image $image nicht ausfuehrbar (Exit $status, Ausgabe oben)"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  fi
  return 0
}

# Signal-Source-Builds fuehren Skripte aus dem Signal-Checkout auf dem Host aus.
# Ein beweglicher Ref ist WARN statt FEHLT, weil Bestandsinstallationen den
# frueheren Default `main` persistiert haben und doctor deploy/update hart
# blockiert; neue Installationen muessen den Ref ausdruecklich waehlen.
_doctor_signal_git_ref() {
  local ref="$1"
  case "$(signal_git_ref_kind "$ref")" in
    commit) _dr_row "OK" "SIGNAL_GIT_REF" "fester Commit ${ref:0:12}" ;;
    tag) _dr_row "OK" "SIGNAL_GIT_REF" "$ref (Tag serverseitig schuetzen; nur ein Commit-SHA ist unveraenderlich)" ;;
    *)
      _dr_row "WARN" "SIGNAL_GIT_REF" "'$ref' ist beweglich: jedes Update baut den neuesten Stand; Commit-SHA setzen"
      _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
      ;;
  esac
}

# ---------------------------------------------------------------------------
# doctor — vorab .env-Validierung. Liefert eine Klartext-Liste (OK/FEHLT/
# SCHWACH/WARN) mit Hinweisen, statt mitten im Deploy an ${VAR:?} oder
# assert_production_env abzubrechen. --fix generiert fehlende Secrets und
# setzt sichere Prod-Defaults. Rückgabe: 0 ok, 1 bei blockierenden Fehlern.
# ---------------------------------------------------------------------------
_DOCTOR_ERRS=0; _DOCTOR_WARNS=0
_dr_row()    { printf '  %-8s %-22s %s\n' "$1" "$2" "$3"; }
# Secret-Zeile: leer ist FEHLT (--fix generiert), zu kurz SCHWACH. Die
# App-Secrets mit 32-Zeichen-Pflicht im Schema (AUTH_SECRET, SECRET_BOX_KEY,
# S3_SECRET_KEY, N8N_HMAC_SECRET) rufen mit short=FEHLT auf: Damit startet
# die App in Produktion nicht (B4). Weder doctor --fix noch deploy/update
# rotieren ein vorhandenes, zu kurzes Secret automatisch.
_dr_secret() {
  local key="$1" min="$2" short="${3:-SCHWACH}" val="${!1:-}"
  if [[ -z "$val" ]]; then
    _dr_row "FEHLT" "$key" "leer -> './taxtronik doctor --fix'"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif (( ${#val} < min )) && [[ "$short" == "FEHLT" ]]; then
    _dr_row "FEHLT" "$key" "nur ${#val} Zeichen (< $min): App startet so nicht; kontrolliert rotieren (docs/operations/secret-rotation.md), --fix rotiert nicht"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif (( ${#val} < min )); then
    _dr_row "SCHWACH" "$key" "nur ${#val} Zeichen (< $min)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_row "OK" "$key" "${#val} Zeichen"
  fi
}

# N8N_HMAC_SECRET verlangt das Schema nur fuer globale Legacy-Callbacks oder
# eine Webhook-Basis (B4: nur bei Bedarf Pflicht); ein gesetzter Wert braucht
# immer 32 Zeichen.
_doctor_n8n_hmac_secret() {
  if [[ -n "${N8N_HMAC_SECRET:-}" || "${N8N_LEGACY_CALLBACKS_ENABLED:-}" == "true" || \
        -n "${N8N_WEBHOOK_BASE_URL:-}" ]]; then
    _dr_secret N8N_HMAC_SECRET 32 FEHLT
  else
    _dr_row "OK" "N8N_HMAC_SECRET" "nicht benoetigt (keine Legacy-Callbacks, keine N8N_WEBHOOK_BASE_URL)"
  fi
}

# B4: Die App verlangt in Produktion HTTPS fuer NEXTAUTH_URL und eine gesetzte
# PORTAL_PUBLIC_URL. Ein leeres NEXTAUTH_URL ersetzt Compose durch
# http://localhost:3000.
_doctor_public_urls() {
  local staff_url="${NEXTAUTH_URL:-}" portal_url="${PORTAL_PUBLIC_URL:-}"
  if [[ -z "$staff_url" ]] && operator_is_production; then
    _dr_row "FEHLT" "NEXTAUTH_URL" "leer: Compose setzt http://localhost:3000, die App verlangt in Produktion HTTPS"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ -z "$staff_url" ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "leer"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ "${staff_url,,}" != https://* ]] && operator_is_production; then
    _dr_row "FEHLT" "NEXTAUTH_URL" "=$staff_url: in Produktion ist HTTPS Pflicht"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$staff_url" == *localhost* || "$staff_url" == *127.0.0.1* ]]; then
    _dr_row "WARN" "NEXTAUTH_URL" "=$staff_url (oeffentliche URL setzen)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_row "OK" "NEXTAUTH_URL" "$staff_url"
  fi
  if [[ -z "$portal_url" ]]; then
    _dr_row "WARN" "PORTAL_PUBLIC_URL" "leer (Single-Host: ok)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  elif [[ "${portal_url,,}" != https://* ]] && operator_is_production; then
    _dr_row "FEHLT" "PORTAL_PUBLIC_URL" "=$portal_url: in Produktion ist HTTPS Pflicht"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  else
    _dr_row "OK" "PORTAL_PUBLIC_URL" "$portal_url"
  fi
}

smtp_points_to_dev_mailhog() {
  local host="${1:-}" port="${2:-}" host_lc
  host_lc="${host,,}"
  [[ "$host_lc" == "mailhog" || ( ( "$host_lc" == "localhost" || "$host" == "127.0.0.1" ) && "$port" == "1025" ) ]]
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

# P-06: Summe der Verbindungs-Pools aller Dienste gegen max_connections. Pro
# Prozess gibt es einen App-Pool (DATABASE_APP_URL) und einen Owner-Pool
# (DATABASE_URL); Defaults wie in infra/compose/docker-compose.app.yml. n8n nutzt
# seinen eigenen TypeORM-Pool (Default 2). Die Reserve deckt superuser_reserved
# (3), migrate, pg_dump/Backup-Drill und manuelle psql-Sitzungen ab.
_DOCTOR_DB_N8N_POOL=2
_DOCTOR_DB_RESERVE=10
_doctor_db_connections() {
  local key val total max limit_warn=0
  local -A pools=(
    [APP_DB_POOL_MAX]="${APP_DB_POOL_MAX:-20}"
    [APP_DB_OWNER_POOL_MAX]="${APP_DB_OWNER_POOL_MAX:-5}"
    [WORKER_DB_POOL_MAX]="${WORKER_DB_POOL_MAX:-5}"
    [WORKER_DB_OWNER_POOL_MAX]="${WORKER_DB_OWNER_POOL_MAX:-10}"
  )
  max="${POSTGRES_MAX_CONNECTIONS:-100}"
  for key in POSTGRES_MAX_CONNECTIONS "${!pools[@]}"; do
    if [[ "$key" == POSTGRES_MAX_CONNECTIONS ]]; then val="$max"; else val="${pools[$key]}"; fi
    if [[ ! "$val" =~ ^[1-9][0-9]{0,4}$ ]]; then
      _dr_row "FEHLT" "$key" "positive ganze Zahl erwartet (ist: '${val}')"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      return 0
    fi
  done
  total=$(( pools[APP_DB_POOL_MAX] + pools[APP_DB_OWNER_POOL_MAX] \
    + pools[WORKER_DB_POOL_MAX] + pools[WORKER_DB_OWNER_POOL_MAX] \
    + _DOCTOR_DB_N8N_POOL + _DOCTOR_DB_RESERVE ))
  local detail="app ${pools[APP_DB_POOL_MAX]}+${pools[APP_DB_OWNER_POOL_MAX]}, worker ${pools[WORKER_DB_POOL_MAX]}+${pools[WORKER_DB_OWNER_POOL_MAX]}, n8n ${_DOCTOR_DB_N8N_POOL}, Reserve ${_DOCTOR_DB_RESERVE}"
  if (( total > max )); then
    _dr_row "FEHLT" "DB_POOLS" "${total} > max_connections ${max} (${detail})"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif (( total * 10 > max * 8 )); then
    _dr_row "WARN" "DB_POOLS" "${total} von max_connections ${max} (>80 %; ${detail})"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_row "OK" "DB_POOLS" "${total} von max_connections ${max} (${detail})"
  fi
  [[ -n "${DATABASE_CONNECTION_LIMIT:-}" ]] && limit_warn=1
  if (( limit_warn )); then
    _dr_row "WARN" "DATABASE_CONNECTION_LIMIT" "veraltet, wirkt in Compose nicht mehr; APP_/WORKER_DB_*POOL_MAX setzen"
    _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  fi
}

# ---------------------------------------------------------------------------
# S-01: Datenbankrollen der Container. app und worker verbinden als
# taxtronik_owner (BYPASSRLS, aber kein Superuser: nur Daten lesen/schreiben;
# Grants aus der Migration 20261006160000_owner_role_least_privilege), der
# Restore-Drill des Workers als taxtronik_drill (CREATEDB + BYPASSRLS fuer die
# Wegwerf-DB, keine Rechte in der Produktiv-DB). Den Superuser taxtronik nutzen
# nur Postgres-Init, der migrate-Container und die Operator-Werkzeuge.
# ---------------------------------------------------------------------------
DB_SUPERUSER_ROLE="taxtronik"
DB_OWNER_ROLE="taxtronik_owner"
DB_DRILL_ROLE="taxtronik_drill"

# Rolle einer postgresql://-URL im environment-Block eines Compose-Dienstes.
# Liest nur die statische Datei (ohne Interpolation) und gibt nie ein
# Passwort aus.
compose_service_db_user() {
  local file="$1" service="$2" key="$3"
  awk -v service="$service" -v key="${key}:" '
    /^[^[:space:]#]/ { current = ""; next }
    /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { current = $1; sub(/:$/, "", current); next }
    current == service && $1 == key {
      url = $2
      if (sub(/^postgres(ql)?:\/\//, "", url)) { sub(/[:@\/].*$/, "", url); print url }
      exit
    }
  ' "$file"
}

# Rolle aus DATABASE_URL eines laufenden Containers (ohne Passwort).
_container_db_user() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | \
    sed -n "s|^$2=postgres\(ql\)\{0,1\}://\([^:@/]*\).*|\2|p" | head -n1 || true
}

_doctor_db_role_row() {
  local status="$1" key="$2" detail="$3"
  _dr_row "$status" "$key" "$detail"
  [[ "$status" == "FEHLT" ]] && _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  [[ "$status" == "WARN" ]] && _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  return 0
}

# Konfiguration: getrennte Secrets und die Rollen der Compose-URLs.
_doctor_db_roles() {
  local owner_pw="${TAXTRONIK_OWNER_PASSWORD:-}" drill_pw="${TAXTRONIK_DRILL_PASSWORD:-}"
  local service user
  if [[ -n "$owner_pw" && -n "$drill_pw" ]]; then
    # Die Container kennen Owner- bzw. Drill-Passwort; ein gleiches Superuser-
    # Passwort gaebe ihnen ueber das Docker-Netz doch wieder volle DB-Kontrolle.
    if [[ "$owner_pw" == "${POSTGRES_PASSWORD:-}" || "$drill_pw" == "${POSTGRES_PASSWORD:-}" || \
          "$owner_pw" == "${TAXTRONIK_APP_PASSWORD:-}" || "$drill_pw" == "${TAXTRONIK_APP_PASSWORD:-}" || \
          "$owner_pw" == "$drill_pw" ]]; then
      _doctor_db_role_row "FEHLT" "DB_ROLE_SECRETS" "Owner-/Drill-Passwort muss sich von Superuser-, App- und dem jeweils anderen Passwort unterscheiden"
    else
      _doctor_db_role_row "OK" "DB_ROLE_SECRETS" "Superuser, App, Owner und Drill getrennt"
    fi
  fi
  for service in app worker; do
    user="$(compose_service_db_user "$APP" "$service" DATABASE_URL)"
    if [[ "$user" == "$DB_OWNER_ROLE" ]]; then
      _doctor_db_role_row "OK" "DB_ROLE_${service^^}" "DATABASE_URL als $user (kein Superuser)"
    elif [[ "$user" == "$DB_SUPERUSER_ROLE" ]]; then
      _doctor_db_role_row "FEHLT" "DB_ROLE_${service^^}" "DATABASE_URL nutzt den Superuser $user statt $DB_OWNER_ROLE"
    else
      _doctor_db_role_row "FEHLT" "DB_ROLE_${service^^}" "DATABASE_URL nutzt '${user:-?}' statt $DB_OWNER_ROLE"
    fi
  done
  user="$(compose_service_db_user "$APP" worker DATABASE_DRILL_URL)"
  if [[ "$user" == "$DB_DRILL_ROLE" ]]; then
    _doctor_db_role_row "OK" "DB_ROLE_DRILL" "Restore-Drill als $user"
  else
    _doctor_db_role_row "FEHLT" "DB_ROLE_DRILL" "worker-DATABASE_DRILL_URL nutzt '${user:-?}' statt $DB_DRILL_ROLE"
  fi
  _doctor_db_roles_live
}

# Laufender Stack: Rollenattribute in Postgres und Rolle der Container. Gehoert
# nicht zum Konfigurations-Gate von deploy/update: Rollen synchronisiert der
# Ablauf erst danach, alte Container ersetzt erst die Aktivierung.
_doctor_db_roles_live() {
  [[ "${_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY:-0}" == "1" ]] && return 0
  command -v docker >/dev/null 2>&1 || return 0
  [[ "$(docker inspect --format '{{.State.Running}}' taxtronik-postgres 2>/dev/null || true)" == "true" ]] || return 0
  local rows row name expected actual container user
  rows="$(docker exec -i taxtronik-postgres \
    psql -X -U "$DB_SUPERUSER_ROLE" -d taxtronik -v ON_ERROR_STOP=1 -At -F ' ' 2>/dev/null <<'SQL'
SELECT r.rolname,
       r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
       EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid),
       CASE
         WHEN r.rolname = 'taxtronik_drill' THEN NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
              AND pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT'))
         WHEN pg_catalog.to_regclass('public.tenant') IS NULL THEN false
         ELSE pg_catalog.has_table_privilege(r.oid, 'public.tenant', 'SELECT')
          AND pg_catalog.has_table_privilege(r.oid, 'public.tenant', 'DELETE')
          AND NOT pg_catalog.has_table_privilege(r.oid, 'public.audit_log', 'UPDATE')
       END
  FROM pg_catalog.pg_roles r
 WHERE r.rolname IN ('taxtronik_owner', 'taxtronik_drill');
SQL
  )" || {
    _doctor_db_role_row "WARN" "DB_ROLES_LIVE" "Rollen in Postgres nicht pruefbar"
    return 0
  }
  for name in "$DB_OWNER_ROLE" "$DB_DRILL_ROLE"; do
    # login super createdb createrole replication bypassrls member grants
    if [[ "$name" == "$DB_OWNER_ROLE" ]]; then expected="t f f f f t f t"; else expected="t f t f f t f t"; fi
    row="$(printf '%s\n' "$rows" | awk -v name="$name" '$1 == name { $1 = ""; sub(/^ /, ""); print }')"
    if [[ -z "$row" ]]; then
      _doctor_db_role_row "FEHLT" "DB_ROLE_LIVE_${name#taxtronik_}" "Rolle $name fehlt in Postgres (./taxtronik update/deploy legt sie an)"
    elif [[ "$name" == "$DB_OWNER_ROLE" && "$row" == "${expected% t} f" ]]; then
      _doctor_db_role_row "FEHLT" "DB_ROLE_LIVE_${name#taxtronik_}" "$name ohne Grants: Migration 20261006160000_owner_role_least_privilege fehlt (./taxtronik update)"
    elif [[ "$row" != "$expected" ]]; then
      actual="login/super/createdb/createrole/replication/bypassrls/member/grants=${row// //}"
      _doctor_db_role_row "FEHLT" "DB_ROLE_LIVE_${name#taxtronik_}" "$name falsch konfiguriert ($actual, erwartet ${expected// //})"
    else
      _doctor_db_role_row "OK" "DB_ROLE_LIVE_${name#taxtronik_}" "$name wie vorgesehen (kein Superuser)"
    fi
  done
  for container in taxtronik-app taxtronik-worker; do
    [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] || continue
    user="$(_container_db_user "$container" DATABASE_URL)"
    if [[ "$user" == "$DB_OWNER_ROLE" ]]; then
      _doctor_db_role_row "OK" "DB_ROLE_RUN_${container#taxtronik-}" "laeuft als $user"
    else
      _doctor_db_role_row "FEHLT" "DB_ROLE_RUN_${container#taxtronik-}" "laeuft als '${user:-?}' statt $DB_OWNER_ROLE (./taxtronik update erstellt den Container neu)"
    fi
  done
}

doctor() {
  local fix=0 deploy_channel=""
  [[ "${1:-}" == "--fix" ]] && fix=1

  [[ -f "$ENVFILE" ]] || { echo "FEHLER: $ENVFILE fehlt. Prod: ./taxtronik deploy" >&2; return 1; }

  if [[ $fix -eq 1 ]]; then
    info "doctor --fix: Secrets + Prod-Defaults ergaenzen"
    deploy_channel="$(deployment_channel 2>/dev/null || true)"
    if [[ "$deploy_channel" == "source" ]]; then
      # Erst bestimmen, dann schreiben: ohne gueltigen HEAD kein leerer Wert.
      local source_version=""
      source_version="$(source_version_for_checkout)" || \
        die "Source-Kennung nicht bestimmbar; TAXTRONIK_VERSION in $ENVFILE bleibt unveraendert."
      set_env TAXTRONIK_DEPLOY_CHANNEL source
      set_env TAXTRONIK_IMAGE_PREFIX taxtronik
      set_env TAXTRONIK_VERSION "$source_version"
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
    # S-01: Owner-Verbindung von app/worker und Restore-Drill-Rolle; bestehende
    # Installationen erhalten beide beim naechsten deploy/update.
    ensure_secret TAXTRONIK_OWNER_PASSWORD 24
    ensure_secret TAXTRONIK_DRILL_PASSWORD 24
    ensure_secret S3_SECRET_KEY 32
    ensure_secret N8N_DB_PASSWORD 24
  fi

  load_env
  _DOCTOR_ERRS=0; _DOCTOR_WARNS=0
  info "doctor — .env-Validierung ($(basename "$ENVFILE"))"

  _dr_secret AUTH_SECRET 32 FEHLT
  if [[ -z "${SECRET_BOX_KEY:-}" ]]; then
    _dr_row "WARN" "SECRET_BOX_KEY" "Legacy-Fallback auf AUTH_SECRET; vor Produktivdaten separat provisionieren"
    _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else
    _dr_secret SECRET_BOX_KEY 32 FEHLT
  fi
  _doctor_n8n_hmac_secret
  _dr_secret N8N_ENCRYPTION_KEY 24
  _doctor_n8n_volume_key
  _dr_secret POSTGRES_PASSWORD 24
  _dr_secret TAXTRONIK_APP_PASSWORD 24
  _dr_secret TAXTRONIK_OWNER_PASSWORD 24
  _dr_secret TAXTRONIK_DRILL_PASSWORD 24
  _dr_secret S3_SECRET_KEY 32 FEHLT
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
  _doctor_db_connections
  _doctor_db_roles

  deploy_channel="$(deployment_channel 2>/dev/null || true)"
  if [[ "$deploy_channel" == "source" ]] && operator_is_production; then
    # Gleicher Hinweis wie das Gate in deploy/update (S-04, Entscheidung C).
    _dr_row "FEHLT" "TAXTRONIK_DEPLOY_CHANNEL" "source ist in Produktion nicht zulaessig"
    printf '           %s\n' "$(production_release_channel_hint)"
    _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "$deploy_channel" == "source" ]]; then
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
    _doctor_source_update_trust
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
  _doctor_obsolete_unsigned_opt_out

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

  _doctor_public_urls

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

  # B-05 (d): Regeln, die nur das App-Schema wiederholten (NEXTAUTH_TRUST_HOST
  # exakt true, TRUST_PROXY_HOPS 1-9, Cookie-Domains, Risk-Layer-Token-Paare
  # und -Laengen), prueft das Schema selbst: im Ziel-Image vor Backup und
  # Migration und hier als SCHEMA_*-Zeilen, sobald das Image lokal vorliegt.
  # doctor behaelt Host-, Compose- und Betriebsregeln.
  if [[ "$deploy_method" == "traefik" && "${TRUST_PROXY_REQUIRED:-}" != "true" ]]; then
    _dr_row "FEHLT" "TRUST_PROXY_REQUIRED" "Traefik-Pfad braucht exakt true"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "${TRUST_PROXY_REQUIRED:-}" != "true" && "${TRUST_PROXY_REQUIRED:-}" != "false" ]]; then
    _dr_row "FEHLT" "TRUST_PROXY_REQUIRED" "explizit true/false setzen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
  elif [[ "${TRUST_PROXY_REQUIRED:-}" == "false" ]]; then
    # S-03: sicherer Default, aber ohne Client-IP greifen Login-Limits nur pro
    # Konto/E-Mail plus globaler Sturmgrenze, und Konten werden nie hart gesperrt.
    _dr_row "WARN" "TRUST_PROXY_REQUIRED" "false: Login-Limits nur pro Konto/E-Mail; Proxy setzt X-Forwarded-For? Dann true"
    _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
  else _dr_row "OK" "TRUST_PROXY_REQUIRED" "$TRUST_PROXY_REQUIRED (deploy/update pruefen die ermittelte Client-IP)"; fi

  # Signal-Besitzvertrag (managed/external/disabled) und verwaltete Artefakte
  # sind Host-Regeln. Paarung, Laenge und Verschiedenheit von RISK_LAYER_TOKEN
  # und RISK_LAYER_OPERATOR_TOKEN prueft das App-Schema (B-05 d). Ein
  # fehlendes Operator-Token bleibt ein Betriebshinweis.
  local rl_url="${RISK_LAYER_URL:-}" rl_tok="${RISK_LAYER_TOKEN:-}"
  local rl_operator_tok="${RISK_LAYER_OPERATOR_TOKEN:-}"
  local rl_festwissen="${RISK_LAYER_FESTWISSEN_DIR:-}"
  local signal_mode=""
  local resolved_signal_image=""
  local signal_channel="" signal_git_url="" signal_git_ref="" signal_git_dir=""
  local signal_llm_dir="" signal_llm_backend="" signal_llm_timeout=""
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
    if [[ "${rl_url%/}" == "http://risk-layer:8000" ]]; then
      _dr_row "OK" "SIGNAL" "verwaltet (http://risk-layer:8000)"
    else
      _dr_row "FEHLT" "RISK_LAYER_URL" "verwaltetes Signal muss http://risk-layer:8000 verwenden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    fi
    if [[ -z "$rl_operator_tok" ]]; then
      _dr_row "WARN" "RISK_LAYER_OPERATOR_TOKEN" "fehlt; Embedding-Steuerung bleibt read-only"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    fi
    signal_channel="$(signal_deploy_channel 2>/dev/null || true)"
    if [[ "$signal_channel" == "source" ]]; then
      signal_git_url="${SIGNAL_GIT_URL:-$SIGNAL_GIT_URL_DEFAULT}"
      signal_git_ref="${SIGNAL_GIT_REF:-$SIGNAL_GIT_REF_DEFAULT}"
      signal_git_dir="$(signal_source_dir)"
      if ! valid_signal_git_url "$signal_git_url"; then
        _dr_row "FEHLT" "SIGNAL_GIT_URL" "nur HTTPS- oder SSH-Git-URL erlaubt"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      elif ! valid_signal_git_ref "$signal_git_ref"; then
        _dr_row "FEHLT" "SIGNAL_GIT_REF" "fehlt/ungueltig: vollstaendigen Commit-SHA (empfohlen) oder refs/tags/<Tag> setzen"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      elif [[ "$signal_git_dir" != /* || "$signal_git_dir" == "/" || \
              "$signal_git_dir" == "$ROOT" || "$signal_git_dir" == "$ROOT/"* ]]; then
        _dr_row "FEHLT" "SIGNAL_GIT_DIR" "absoluter eigener Checkout-Pfad erforderlich"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
      else
        _dr_row "OK" "SIGNAL_SOURCE" "$signal_git_url @ $signal_git_ref"
        _doctor_signal_git_ref "$signal_git_ref"
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
    signal_llm_dir="$(signal_llm_dir)"
    signal_llm_backend="${RISK_LAYER_LLM_BACKEND:-cpu}"
    signal_llm_timeout="${RISK_LAYER_LLM_TIMEOUT:-$SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT}"
    if ! validate_signal_llm_dir "$signal_llm_dir"; then
      _dr_row "FEHLT" "SIGNAL_LLM_DIR" "absoluter, nicht verlinkter Pfad erforderlich"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    elif [[ -f "$signal_llm_dir/$SIGNAL_MANAGED_LLM_FILE" && \
            -x "$signal_llm_dir/runtime/llama-server" && \
            -f "$signal_llm_dir/managed-llm.json" ]]; then
      _dr_row "OK" "SIGNAL_LLM" "$SIGNAL_MANAGED_LLM_MODEL bereit (CPU-Bottleneck)"
    else
      _dr_row "WARN" "SIGNAL_LLM" "wird beim Deploy hash-gepinnt provisioniert (~6,25 GB; CPU-Bottleneck)"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    fi
    if [[ "$signal_llm_backend" != "cpu" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_LLM_BACKEND" "verwaltetes One-Click-Signal muss cpu verwenden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER_LLM_BACKEND" "cpu (langsam, aber ohne GPU funktionsfaehig)"
    fi
    if [[ ! "$signal_llm_timeout" =~ ^[0-9]+$ ]] || (( 10#$signal_llm_timeout < 300 )); then
      _dr_row "FEHLT" "RISK_LAYER_LLM_TIMEOUT" "fuer CPU mindestens 300 Sekunden"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER_LLM_TIMEOUT" "${signal_llm_timeout}s"
    fi
    if [[ -n "$rl_festwissen" ]]; then
      _dr_row "WARN" "RISK_LAYER_FESTWISSEN_DIR" "wird im verwalteten Self-contained-Image nicht mehr verwendet"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    fi
  else
    # signal_deployment_mode liefert sonst nur noch external.
    _dr_row "OK" "SIGNAL_DEPLOYMENT" "external"
    if [[ -z "$rl_url" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_URL" "externes Signal braucht eine erreichbare URL"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    elif [[ "${rl_url%/}" == "http://risk-layer:8000" ]]; then
      _dr_row "FEHLT" "RISK_LAYER_URL" "Compose-DNS gehoert zum verwalteten Modus"; _DOCTOR_ERRS=$((_DOCTOR_ERRS+1))
    else
      _dr_row "OK" "RISK_LAYER" "extern: $rl_url"
    fi
    if [[ -n "$rl_url" && -z "$rl_operator_tok" ]]; then
      _dr_row "WARN" "RISK_LAYER_OPERATOR_TOKEN" "fehlt; Embedding-Steuerung bleibt read-only"; _DOCTOR_WARNS=$((_DOCTOR_WARNS+1))
    fi
    _dr_row "OK" "SIGNAL_UPDATE" "extern verwaltet; TaxTronik aktualisiert Signal nicht"
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

  _doctor_app_env_schema

  echo
  if (( _DOCTOR_ERRS > 0 )); then
    echo "  -> $_DOCTOR_ERRS Fehler, $_DOCTOR_WARNS Warnung(en). Blockierend — erst beheben."
    [[ $fix -eq 0 ]] && echo "  Tipp: './taxtronik doctor --fix' generiert fehlende Secrets."
    return 1
  fi
  echo "  -> $_DOCTOR_WARNS Warnung(en). Bereit zum Deploy."
  return 0
}
