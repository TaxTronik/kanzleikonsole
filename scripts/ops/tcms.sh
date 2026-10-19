#!/usr/bin/env bash
# =============================================================================
# Tax-CMS (TCMS) — Teil der Operator-CLI (./taxtronik).
#
# Besitzvertrag managed/external/disabled nach dem Muster der Signal-Engine,
# aber ohne deren Luecken (TCMS Stufe 2, docs/operations/tcms-betrieb.md):
# eigene interne Netze statt eines flachen Netzes, Images nur per Digest aus
# dem signierten Release-Stand, Rotation mit Ueberlappung.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

# Repository-relativer Pfad fuer `git show <commit>:<pfad>`.
TCMS_RELEASE_PINS_PATH="infra/compose/tcms-release.env"
TCMS_MANAGED_URL="http://tcms-api:3200"
TCMS_DB_CONTAINER="taxtronik-tcms-db"
TCMS_MIGRATE_CONTAINER="taxtronik-tcms-migrate"
TCMS_API_CONTAINER="taxtronik-tcms-api"
TCMS_BACKEND_NETWORK="taxtronik-tcms-backend"
TCMS_FRONTEND_NETWORK="taxtronik-tcms-frontend"
# Schnittstelle "Rotation mit Ueberlappung": Bestaetigungen leben <= 120 s;
# zwischen Umstellen von app/worker und Entfernen des alten oeffentlichen
# Schluessels liegen mindestens 5 Minuten. Fuer Dienst-Tokens nennt die
# Schnittstelle keine Wartezeit: app/worker sind beim Entfernen bereits mit dem
# neuen Token neu gestartet, alte Prozesse existieren nicht mehr.
TCMS_KEY_ROTATION_MIN_WAIT=300
TCMS_TOKEN_ROTATION_MIN_WAIT=0
# Formate wie im TCMS-Vertrag (packages/contract/src/signatur.ts, ADR §3):
# privater Schluessel = PKCS#8-DER (Ed25519, 48 Byte) als kanonisches base64,
# oeffentlicher = SPKI-DER (44 Byte) als kanonisches base64 mit Padding; das
# letzte Datenzeichen traegt nur 4 Bit (kanonisch: untere 2 Bit null).
TCMS_PKCS8_PATTERN='^MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{43}$'
TCMS_SPKI_PATTERN='^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
TCMS_KID_PATTERN='^[A-Za-z0-9._-]{1,64}$'
# Dienst-Token wie die Konfigurationspruefung des Dienstes (apps/api,
# konfiguration.ts): 32-512 Zeichen, base64-Alphabet, kein Platzhalterwort,
# mindestens 8 verschiedene Zeichen.
TCMS_TOKEN_PATTERN='^[A-Za-z0-9._~+/-]{32,512}=*$'
TCMS_PLACEHOLDER_PATTERN='(ersetzen|replace|change.?me|platzhalter|placeholder|beispiel|example|dummy|secret|geheim|passwor|xxxx)'

# ---------------------------------------------------------------------------
# Besitzvertrag
# ---------------------------------------------------------------------------
# Leer heisst disabled: Bestandsinstallationen ohne TCMS bleiben unveraendert.
# Jeder andere Wert ist ein Konfigurationsfehler (rc 1), nie still disabled.
tcms_deployment_mode() {
  local configured="${TCMS_DEPLOYMENT:-$(get_env TCMS_DEPLOYMENT)}"
  case "$configured" in
    managed|external|disabled) printf '%s' "$configured" ;;
    "") printf 'disabled' ;;
    *) return 1 ;;
  esac
}

# Wert so, wie Compose ihn interpoliert: Eine gesetzte Prozessvariable (auch
# leer) gewinnt vor der .env. Der Image-Guard prueft damit genau den Wert, den
# Compose verwendet; ein leerer Prozesswert kann einen gueltigen .env-Digest
# nicht verdecken.
tcms_effective_env() {
  local key="$1"
  if [[ -v "$key" ]]; then printf '%s' "${!key}"
  else get_env "$key"; fi
}

# ---------------------------------------------------------------------------
# Release-Pins der TCMS-Images (infra/compose/tcms-release.env)
# ---------------------------------------------------------------------------
# Liest die Pins aus genau einem Commit, nie aus dem Arbeitsbaum. Ausgabe:
# drei Zeilen Version, API-Digest, Migrate-Digest (alle leer = der Stand
# verankert kein TCMS-Release). rc 1 bei fehlender Datei oder Formatfehler.
tcms_read_release_pins() {
  local commit="$1" content line key value seen=" " version="" api="" migrate=""
  [[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || {
    printf 'FEHLER: TCMS-Pins brauchen einen vollstaendigen Commit-SHA.\n' >&2
    return 1
  }
  content="$(git -C "$ROOT" show "${commit}:${TCMS_RELEASE_PINS_PATH}" 2>/dev/null)" || {
    printf 'FEHLER: %s fehlt im Commit %s.\n' "$TCMS_RELEASE_PINS_PATH" "${commit:0:12}" >&2
    return 1
  }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^(TCMS_RELEASE_VERSION|TCMS_RELEASE_API_DIGEST|TCMS_RELEASE_MIGRATE_DIGEST)=(.*)$ ]]; then
      printf 'FEHLER: %s enthaelt eine unbekannte Zeile.\n' "$TCMS_RELEASE_PINS_PATH" >&2
      return 1
    fi
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    if [[ "$seen" == *" $key "* ]]; then
      printf 'FEHLER: %s nennt %s mehrfach.\n' "$TCMS_RELEASE_PINS_PATH" "$key" >&2
      return 1
    fi
    seen+="$key "
    case "$key" in
      TCMS_RELEASE_VERSION) version="$value" ;;
      TCMS_RELEASE_API_DIGEST) api="$value" ;;
      TCMS_RELEASE_MIGRATE_DIGEST) migrate="$value" ;;
    esac
  done <<<"$content"
  for key in TCMS_RELEASE_VERSION TCMS_RELEASE_API_DIGEST TCMS_RELEASE_MIGRATE_DIGEST; do
    [[ "$seen" == *" $key "* ]] || {
      printf 'FEHLER: %s nennt %s nicht.\n' "$TCMS_RELEASE_PINS_PATH" "$key" >&2
      return 1
    }
  done
  if [[ -n "$version$api$migrate" ]]; then
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
       "$api" =~ ^sha256:[0-9a-f]{64}$ && "$migrate" =~ ^sha256:[0-9a-f]{64}$ && \
       "$api" != "$migrate" ]] || {
      printf 'FEHLER: %s: Version X.Y.Z und zwei verschiedene sha256-Digests erwartet (oder alle leer).\n' \
        "$TCMS_RELEASE_PINS_PATH" >&2
      return 1
    }
  fi
  printf '%s\n%s\n%s\n' "$version" "$api" "$migrate"
}

# Zerlegt die Ausgabe von tcms_read_release_pins in _TCMS_PIN_VERSION,
# _TCMS_PIN_API und _TCMS_PIN_MIGRATE. Die Befehlsersetzung entfernt die
# Leerzeilen leerer Pins; ein nacktes `read` liefe dann auf EOF und beendete
# unter `set -e` den ganzen Lauf ohne Meldung.
tcms_split_pins() {
  local version="" api="" migrate=""
  { read -r version || true; read -r api || true; read -r migrate || true; } <<<"${1:-}"
  _TCMS_PIN_VERSION="$version"
  _TCMS_PIN_API="$api"
  _TCMS_PIN_MIGRATE="$migrate"
}

# Teil des Compose-Guards (ensure_compose_image_pinning, Release-Kanal): Ein
# verwaltetes Tax-CMS laeuft nur mit Digests aus dem signierten Release-Stand.
# Ausserhalb von deploy/update/rollback sind das die Pins des verifizierten
# Last-Good-Commits aus STATE; waehrend einer Aktivierung die aus dem signiert
# verifizierten Ziel-Commit gestagten Prozesswerte (tcms_stage_release_pins).
ensure_tcms_image_pinning() {
  local commit="$1" mode version api_suffix migrate_suffix pins
  local pinned_version="" pinned_migrate=""
  local pinned_api=""
  mode="$(tcms_deployment_mode)" || \
    die "Registry-Compose verweigert: TCMS_DEPLOYMENT muss managed, external oder disabled sein."
  [[ "$mode" == "managed" ]] || return 0
  version="$(tcms_effective_env TCMS_VERSION)"
  api_suffix="$(tcms_effective_env TCMS_API_DIGEST_SUFFIX)"
  migrate_suffix="$(tcms_effective_env TCMS_MIGRATE_DIGEST_SUFFIX)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Registry-Compose verweigert: TCMS_VERSION muss die TCMS-Version X.Y.Z aus dem signierten Release-Stand sein."
  [[ "$api_suffix" =~ ^@sha256:[0-9a-f]{64}$ ]] || \
    die "Registry-Compose verweigert: TCMS_API_DIGEST_SUFFIX fehlt/ist ungueltig. Erst signierten Release-Vertrag via deploy/update aufloesen."
  [[ "$migrate_suffix" =~ ^@sha256:[0-9a-f]{64}$ ]] || \
    die "Registry-Compose verweigert: TCMS_MIGRATE_DIGEST_SUFFIX fehlt/ist ungueltig. Erst signierten Release-Vertrag via deploy/update aufloesen."
  [[ "${_TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED:-0}" == "1" ]] && return 0
  pins="$(tcms_read_release_pins "$commit")" || \
    die "Registry-Compose verweigert: TCMS-Pins des verifizierten Release-Commits sind nicht lesbar."
  tcms_split_pins "$pins"
  pinned_version="$_TCMS_PIN_VERSION"; pinned_api="$_TCMS_PIN_API"; pinned_migrate="$_TCMS_PIN_MIGRATE"
  [[ -n "$pinned_version" ]] || \
    die "Registry-Compose verweigert: Der verifizierte Release-Stand verankert kein TCMS-Release; TCMS_DEPLOYMENT=managed ist so nicht betreibbar (./taxtronik tcms disable oder Update auf einen Release mit TCMS)."
  [[ "$version" == "$pinned_version" && "$api_suffix" == "@$pinned_api" && \
     "$migrate_suffix" == "@$pinned_migrate" ]] || \
    die "Registry-Compose verweigert: TCMS-Images in .env/Prozess weichen vom signierten Release-Stand ab. deploy/update/rollback verwenden."
}

# ---------------------------------------------------------------------------
# Formate (ohne Werte auszugeben)
# ---------------------------------------------------------------------------
tcms_valid_token() {
  local token="${1:-}" index distinct=""
  (( ${#token} >= 32 && ${#token} <= 512 )) || return 1
  [[ "$token" =~ $TCMS_TOKEN_PATTERN ]] || return 1
  [[ ! "${token,,}" =~ $TCMS_PLACEHOLDER_PATTERN ]] || return 1
  for (( index = 0; index < ${#token}; index++ )); do
    [[ "$distinct" == *"${token:index:1}"* ]] || distinct+="${token:index:1}"
    (( ${#distinct} >= 8 )) && return 0
  done
  return 1
}

# Komma-Liste ohne Leerzeichen, jeder Eintrag gueltig, keine Doppelten.
tcms_valid_token_list() {
  local list="${1:-}" entry seen=","
  [[ -n "$list" && "$list" != *,, && "$list" != ,* && "$list" != *, && "$list" != *[[:space:]]* ]] || return 1
  local -a entries
  IFS=',' read -r -a entries <<<"$list"
  for entry in "${entries[@]}"; do
    tcms_valid_token "$entry" || return 1
    [[ "$seen" != *",$entry,"* ]] || return 1
    seen+="$entry,"
  done
}

tcms_token_list_contains() {
  local list="${1:-}" token="${2:-}"
  [[ -n "$token" && ",$list," == *",$token,"* ]]
}

tcms_valid_kid() { [[ "${1:-}" =~ $TCMS_KID_PATTERN ]]; }
tcms_valid_private_key() { [[ "${1:-}" =~ $TCMS_PKCS8_PATTERN ]]; }
tcms_valid_public_key() { [[ "${1:-}" =~ $TCMS_SPKI_PATTERN ]]; }

# kid=SPKI, kommagetrennt; kid und Schluesselmaterial jeweils eindeutig.
tcms_valid_public_key_list() {
  local list="${1:-}" entry kid key kids="," keys=","
  [[ -n "$list" && "$list" != *,, && "$list" != ,* && "$list" != *, && "$list" != *[[:space:]]* ]] || return 1
  local -a entries
  IFS=',' read -r -a entries <<<"$list"
  for entry in "${entries[@]}"; do
    [[ "$entry" == *=* ]] || return 1
    kid="${entry%%=*}"; key="${entry#*=}"
    tcms_valid_kid "$kid" && tcms_valid_public_key "$key" || return 1
    [[ "$kids" != *",$kid,"* && "$keys" != *",$key,"* ]] || return 1
    kids+="$kid,"; keys+="$key,"
  done
}

# Oeffentlicher Schluessel zu einem kid der Liste (leer, wenn nicht gelistet).
tcms_public_key_of_kid() {
  local list="${1:-}" wanted="${2:-}" entry
  local -a entries
  IFS=',' read -r -a entries <<<"$list"
  for entry in "${entries[@]}"; do
    if [[ "${entry%%=*}" == "$wanted" ]]; then printf '%s' "${entry#*=}"; return 0; fi
  done
  return 0
}

tcms_kids_of_list() {
  local list="${1:-}" entry out=""
  local -a entries
  IFS=',' read -r -a entries <<<"$list"
  for entry in "${entries[@]}"; do out+="${out:+, }${entry%%=*}"; done
  printf '%s' "$out"
}

# Leitet den oeffentlichen aus dem privaten Schluessel ab. Der private
# Schluessel geht nur ueber stdin an base64/openssl, nie in eine Kommandozeile.
tcms_public_key_for_private() {
  local private="${1:-}" public=""
  tcms_valid_private_key "$private" || return 1
  require_cmd openssl
  public="$(printf '%s' "$private" | base64 -d 2>/dev/null | \
    openssl pkey -inform DER -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')" || return 1
  tcms_valid_public_key "$public" || return 1
  printf '%s' "$public"
}

# Nicht geheimer Kurzbezeichner eines Tokens fuer Zustand und Status.
tcms_token_id() {
  local digest
  digest="$(printf '%s' "${1:-}" | sha256sum | cut -c1-16)"
  printf 'tok:%s' "$digest"
}

# ---------------------------------------------------------------------------
# Erzeugung neuer Geheimnisse
# ---------------------------------------------------------------------------
# Neues Dienst-Token, verschieden von allen uebergebenen Werten.
tcms_generate_token() {
  local candidate existing ok
  for _ in 1 2 3 4 5; do
    candidate="$(rand_b64 32)"
    tcms_valid_token "$candidate" || continue
    ok=1
    for existing in "$@"; do [[ "$candidate" != "$existing" ]] || ok=0; done
    (( ok == 1 )) && { printf '%s' "$candidate"; return 0; }
  done
  die "Neues TCMS-Dienst-Token konnte nicht sicher erzeugt werden (Zufallsquelle pruefen)."
}

# Neues Ed25519-Schluesselpaar im Format des TCMS-Vertrags; kid wie
# `pnpm akteur:schluessel` (kk-<Datum>-<Fingerabdruck des SPKI>). Setzt
# _TCMS_GEN_KID, _TCMS_GEN_PRIVATE, _TCMS_GEN_PUBLIC; gibt nichts aus. openssl
# erzeugt den Schluessel in eine Pipe; kein Wert steht in einer Kommandozeile
# oder Datei.
tcms_generate_keypair() {
  local avoid_list="${1:-}" private="" public="" fingerprint="" kid=""
  require_cmd openssl
  private="$(openssl genpkey -algorithm ed25519 -outform DER 2>/dev/null | base64 | tr -d '\n')" || \
    die "Ed25519-Schluessel konnte nicht erzeugt werden (openssl genpkey)."
  tcms_valid_private_key "$private" || die "openssl lieferte keinen PKCS#8-Ed25519-Schluessel."
  public="$(tcms_public_key_for_private "$private")" || \
    die "Oeffentlicher Schluessel konnte nicht abgeleitet werden."
  fingerprint="$(printf '%s' "$public" | base64 -d | openssl dgst -sha256 -binary | \
    base64 | tr '+/' '-_' | tr -d '=\n')" || die "Schluessel-Fingerabdruck nicht berechenbar."
  kid="kk-$(date -u +%Y-%m-%d)-${fingerprint:0:8}"
  tcms_valid_kid "$kid" || die "Erzeugter kid ist ungueltig."
  [[ -z "$(tcms_public_key_of_kid "$avoid_list" "$kid")" ]] || \
    die "Erzeugter kid $kid ist bereits vergeben; erneut versuchen."
  _TCMS_GEN_KID="$kid"
  _TCMS_GEN_PRIVATE="$private"
  _TCMS_GEN_PUBLIC="$public"
}

# set_env und Prozessumgebung gemeinsam: load_env hat die alten Werte
# exportiert, und Compose bevorzugt Prozesswerte vor der .env. Ohne Export
# starteten Container nach einer Aenderung mit dem alten Wert.
tcms_set() {
  set_env "$1" "$2"
  export "$1=$2"
}

tcms_installed() { [[ -f "$STATE" ]]; }

# ---------------------------------------------------------------------------
# Konfiguration je Modus (ohne Rotation vorhandener Geheimnisse)
# ---------------------------------------------------------------------------
# Fehlende DB-Passwoerter erzeugen. Vorhandene bleiben: Das Superuser-Passwort
# gilt ab dem ersten Start des Volumes, die Rollenpasswoerter gleicht
# tcms-migrate an (Rotation: docs/operations/secret-rotation.md).
tcms_ensure_db_passwords() {
  local key value others
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
    value="${!key:-}"
    [[ -z "$value" ]] || continue
    others="${TCMS_DB_SUPERUSER_PASSWORD:-}|${TCMS_DB_OWNER_PASSWORD:-}|${TCMS_DB_APP_PASSWORD:-}|${POSTGRES_PASSWORD:-}"
    value="$(rand_b64 32)"
    [[ ${#value} -ge 32 && "|$others|" != *"|$value|"* ]] || \
      die "Getrenntes Passwort fuer $key konnte nicht sicher erzeugt werden."
    tcms_set "$key" "$value"
    info "$key erzeugt."
  done
}

# Dienst-Token und Schluesselpaar fuer managed: erzeugen, wenn sie fehlen;
# vorhandene muessen zueinander passen (keine stille Reparatur).
tcms_ensure_managed_credentials() {
  local token="${TCMS_SERVICE_TOKEN:-}" tokens="${TCMS_SERVICE_TOKENS:-}"
  local private="${TCMS_ACTOR_PRIVATE_KEY:-}" kid="${TCMS_ACTOR_KEY_ID:-}" keys="${TCMS_ACTOR_PUBLIC_KEYS:-}"
  local public=""
  if [[ -z "$token" ]]; then
    [[ -z "$tokens" ]] || die "TCMS_SERVICE_TOKEN fehlt, TCMS_SERVICE_TOKENS ist gesetzt: Konfiguration klaeren (./taxtronik doctor)."
    token="$(tcms_generate_token)"
    tcms_set TCMS_SERVICE_TOKEN "$token"
    tcms_set TCMS_SERVICE_TOKENS "$token"
    info "TCMS-Dienst-Token erzeugt."
  elif [[ -z "$tokens" ]]; then
    tcms_valid_token "$token" || die "TCMS_SERVICE_TOKEN hat kein gueltiges Format; ./taxtronik tcms rotate-token nach Korrektur."
    tcms_set TCMS_SERVICE_TOKENS "$token"
  fi
  if [[ -z "$private" ]]; then
    [[ -z "$keys" && -z "$kid" ]] || die "TCMS_ACTOR_PRIVATE_KEY fehlt, kid/oeffentliche Schluessel sind gesetzt: Konfiguration klaeren (./taxtronik doctor)."
    tcms_generate_keypair ""
    tcms_set TCMS_ACTOR_PRIVATE_KEY "$_TCMS_GEN_PRIVATE"
    tcms_set TCMS_ACTOR_KEY_ID "$_TCMS_GEN_KID"
    tcms_set TCMS_ACTOR_PUBLIC_KEYS "${_TCMS_GEN_KID}=${_TCMS_GEN_PUBLIC}"
    info "Ed25519-Akteursschluessel erzeugt (kid ${_TCMS_GEN_KID})."
  elif [[ -z "$keys" ]]; then
    tcms_valid_kid "$kid" || die "TCMS_ACTOR_KEY_ID fehlt oder ist ungueltig."
    public="$(tcms_public_key_for_private "$private")" || die "TCMS_ACTOR_PRIVATE_KEY ist kein PKCS#8-Ed25519-Schluessel."
    tcms_set TCMS_ACTOR_PUBLIC_KEYS "${kid}=${public}"
  fi
  unset _TCMS_GEN_PRIVATE
}

# Image-Werte im Release-Kanal: Pins des verifizierten Last-Good-Commits
# (STATE). Vor der Erstinstallation setzt deploy sie aus dem signierten Stand.
tcms_set_images_from_state() {
  local commit pins version="" api="" migrate=""
  images_from_registry || return 0
  tcms_installed || return 0
  commit="$(state_value current_commit)"
  pins="$(tcms_read_release_pins "$commit")" || die "TCMS-Pins des installierten Release-Stands sind nicht lesbar."
  tcms_split_pins "$pins"
  version="$_TCMS_PIN_VERSION"; api="$_TCMS_PIN_API"; migrate="$_TCMS_PIN_MIGRATE"
  [[ -n "$version" ]] || \
    die "Der installierte Release verankert kein TCMS-Release; managed ist erst nach einem Update auf einen Release mit TCMS moeglich."
  tcms_set TCMS_VERSION "$version"
  tcms_set TCMS_API_DIGEST_SUFFIX "@$api"
  tcms_set TCMS_MIGRATE_DIGEST_SUFFIX "@$migrate"
}

# Lokaler Tag im Source-Kanal (ausserhalb Produktion): kein latest, kein Digest.
tcms_valid_local_tag() {
  [[ "${1:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ && "${1:-}" != latest ]]
}

tcms_configure_managed() {
  if images_from_registry; then
    tcms_set_images_from_state
  else
    prompt "Lokaler TCMS-Image-Tag (taxtronik/tcms-api:<tag>, Source-Kanal)" TCMS_VERSION ""
    tcms_valid_local_tag "${TCMS_VERSION:-}" || \
      die "TCMS_VERSION muss im Source-Kanal einen lokal gebauten Tag nennen (nicht latest)."
    tcms_set TCMS_VERSION "$TCMS_VERSION"
    tcms_set TCMS_API_DIGEST_SUFFIX ""
    tcms_set TCMS_MIGRATE_DIGEST_SUFFIX ""
  fi
  tcms_ensure_db_passwords
  tcms_ensure_managed_credentials
  tcms_set TCMS_URL "$TCMS_MANAGED_URL"
  tcms_set TCMS_DEPLOYMENT managed
}

tcms_valid_external_url() {
  local url="${1:-}"
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] || return 1
  [[ "${url%/}" != "${TCMS_MANAGED_URL}" ]]
}

# Eigener oeffentlicher Schluessel fuer die Betreiber eines externen Tax-CMS.
# Oeffentlich und damit ausgebbar; der private Schluessel bleibt in .env.
tcms_print_public_key_entry() {
  local public
  public="$(tcms_public_key_for_private "${TCMS_ACTOR_PRIVATE_KEY:-}")" || return 0
  printf '\nOeffentlicher Akteursschluessel fuer das externe Tax-CMS (an TCMS_ACTOR_PUBLIC_KEYS anhaengen):\n'
  printf '  %s=%s\n\n' "${TCMS_ACTOR_KEY_ID:-}" "$public"
}

tcms_configure_external() {
  local url="${TCMS_URL:-}" token="${TCMS_SERVICE_TOKEN:-}"
  [[ "${url%/}" != "$TCMS_MANAGED_URL" ]] || url=""
  if [[ -z "$url" && -t 0 ]]; then
    read -rp 'URL des externen Tax-CMS (https://..., aus den TaxTronik-Containern erreichbar): ' url || true
  fi
  tcms_valid_external_url "$url" || die "Externe TCMS_URL muss eine HTTPS-URL ohne Zugangsdaten sein."
  if ! tcms_valid_token "$token" && [[ -t 0 ]]; then
    read -rsp 'Dienst-Token des externen Tax-CMS (wird nicht angezeigt): ' token || true
    printf '\n'
  fi
  tcms_valid_token "$token" || die "Dienst-Token fehlt oder hat kein gueltiges Format (32-512 Zeichen, kein Platzhalter)."
  if ! tcms_valid_private_key "${TCMS_ACTOR_PRIVATE_KEY:-}" || ! tcms_valid_kid "${TCMS_ACTOR_KEY_ID:-}"; then
    tcms_generate_keypair ""
    tcms_set TCMS_ACTOR_PRIVATE_KEY "$_TCMS_GEN_PRIVATE"
    tcms_set TCMS_ACTOR_KEY_ID "$_TCMS_GEN_KID"
    unset _TCMS_GEN_PRIVATE
    info "Ed25519-Akteursschluessel erzeugt (kid $TCMS_ACTOR_KEY_ID)."
  fi
  tcms_set TCMS_URL "${url%/}"
  tcms_set TCMS_SERVICE_TOKEN "$token"
  # Dienstseitige Listen gehoeren dem externen Betreiber.
  tcms_set TCMS_SERVICE_TOKENS ""
  tcms_set TCMS_ACTOR_PUBLIC_KEYS ""
  tcms_set TCMS_DEPLOYMENT external
  tcms_print_public_key_entry
}

# Nicht-interaktiver Teil von deploy/update (prepare_env_interactive). Ein
# fehlender Modus wird als disabled persistiert, damit ein normales Update nie
# nachfragt; einschalten nur bewusst per ./taxtronik tcms setup oder im
# Initialsetup.
configure_tcms_for_env() {
  local mode
  mode="$(tcms_deployment_mode)" || die "TCMS_DEPLOYMENT muss managed, external oder disabled sein."
  case "$mode" in
    disabled) [[ -n "$(get_env TCMS_DEPLOYMENT)" ]] || set_env TCMS_DEPLOYMENT disabled ;;
    managed)
      tcms_ensure_db_passwords
      tcms_ensure_managed_credentials
      [[ "${TCMS_URL:-}" == "$TCMS_MANAGED_URL" ]] || tcms_set TCMS_URL "$TCMS_MANAGED_URL"
      ;;
    external)
      if ! tcms_valid_private_key "${TCMS_ACTOR_PRIVATE_KEY:-}"; then
        tcms_generate_keypair ""
        tcms_set TCMS_ACTOR_PRIVATE_KEY "$_TCMS_GEN_PRIVATE"
        tcms_set TCMS_ACTOR_KEY_ID "$_TCMS_GEN_KID"
        unset _TCMS_GEN_PRIVATE
        tcms_print_public_key_entry
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Container-Lebenszyklus (managed)
# ---------------------------------------------------------------------------
# Images bereitstellen: Release-Kanal zieht per Digest (Docker prueft den
# Inhalt gegen den Digest) und prueft das Versionslabel; Source-Kanal
# verlangt lokal gebaute Tags.
provide_tcms_images() {
  local prefix="${TAXTRONIK_IMAGE_PREFIX:-taxtronik}" role suffix ref label
  [[ "$(tcms_deployment_mode)" == "managed" ]] || return 0
  [[ -n "${TCMS_VERSION:-}" ]] || die "TCMS_VERSION fehlt; managed ist ohne TCMS-Image nicht betreibbar."
  for role in api migrate; do
    if [[ "$role" == "api" ]]; then suffix="${TCMS_API_DIGEST_SUFFIX:-}"; else suffix="${TCMS_MIGRATE_DIGEST_SUFFIX:-}"; fi
    ref="${prefix%/}/tcms-$role:${TCMS_VERSION}${suffix}"
    if images_from_registry; then
      [[ "$suffix" =~ ^@sha256:[0-9a-f]{64}$ ]] || die "tcms-$role ohne Digest aus dem signierten Release-Stand verweigert."
      info "TCMS-Image per Digest beziehen: $ref"
      docker pull "$ref" >/dev/null || die "tcms-$role konnte nicht bezogen werden (Registry-Zugang pruefen)."
      label="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ref" 2>/dev/null || true)"
      [[ "$label" == "$TCMS_VERSION" ]] || \
        die "tcms-$role-Label version=$label stimmt nicht mit der signierten TCMS-Version $TCMS_VERSION ueberein."
    else
      [[ -z "$suffix" ]] || die "Source-Kanal: TCMS-Digest-Suffixe muessen leer sein (lokale Images)."
      docker image inspect "$ref" >/dev/null 2>&1 || \
        die "Lokales Image $ref fehlt. Im TCMS-Checkout bauen (docs/operations/tcms-betrieb.md, Abschnitt 3)."
    fi
  done
}

tcms_wait_db_healthy() {
  local deadline status
  deadline=$(( $(date +%s) + 120 ))
  while :; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$TCMS_DB_CONTAINER" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ $(date +%s) -lt $deadline ]] || die "tcms-db nach 120 s nicht healthy."
    sleep 2
  done
}

# Migrationsschritt ausdruecklich und mit ausgewertetem Exit-Code; der
# beendete Container bleibt fuer doctor/status sichtbar.
run_tcms_migrate() {
  local code
  info "TCMS-Migrationsschritt (Rollen-Bootstrap, Migrationen, Pruefung)"
  docker rm -f "$TCMS_MIGRATE_CONTAINER" >/dev/null 2>&1 || true
  compose --profile tcms up -d --no-deps tcms-migrate || die "tcms-migrate konnte nicht gestartet werden."
  code="$(docker wait "$TCMS_MIGRATE_CONTAINER" 2>/dev/null || echo 1)"
  if [[ "$code" != "0" ]]; then
    compose --profile tcms logs --no-color --tail 80 tcms-migrate >&2 || true
    die "tcms-migrate fehlgeschlagen (Exit $code); tcms-api bleibt auf dem bisherigen Stand."
  fi
}

tcms_restart_api() {
  info "tcms-api neu starten und Healthcheck abwarten"
  compose --profile tcms up -d --no-deps --force-recreate --wait --wait-timeout 180 tcms-api || {
    compose --profile tcms ps tcms-api >&2 || true
    compose --profile tcms logs --no-color --tail 80 tcms-api >&2 || true
    return 1
  }
}

# tcms-api mit anderen Images (Rueckfall auf Last-Good); die Werte gelten nur
# fuer diesen Aufruf (lokal, fuer Compose exportiert).
tcms_restart_api_with() {
  local TCMS_VERSION="$1" TCMS_API_DIGEST_SUFFIX="$2" TCMS_MIGRATE_DIGEST_SUFFIX="$3"
  export TCMS_VERSION TCMS_API_DIGEST_SUFFIX TCMS_MIGRATE_DIGEST_SUFFIX
  tcms_restart_api
}

# App und Worker mit der aktuellen Umgebung neu erzeugen (Netze, TCMS-Werte).
tcms_restart_writers() {
  info "App und Worker mit neuer TCMS-Konfiguration neu starten"
  compose up -d --no-deps --force-recreate --wait --wait-timeout 300 app worker || \
    die "App/Worker konnten nicht neu gestartet werden."
  smoke_health || die "App nach dem Neustart nicht healthy."
}

# Datenbank -> Migration -> Dienst. Fehler vor dem Dienstwechsel lassen den
# laufenden tcms-api unveraendert.
start_tcms_services() {
  [[ "$(tcms_deployment_mode)" == "managed" ]] || return 0
  info "TCMS-Datenbank starten"
  compose --profile tcms up -d --no-deps tcms-db || die "tcms-db konnte nicht gestartet werden."
  tcms_wait_db_healthy
  run_tcms_migrate
  tcms_restart_api || die "tcms-api wurde nicht healthy (Diagnose oben, ohne Werte)."
}

# Aktiviert ein verwaltetes Tax-CMS auf einer laufenden Installation.
tcms_activate() {
  provide_tcms_images
  start_tcms_services
  tcms_restart_writers
}

# Entfernt verwaltete TCMS-Container und -Netze. Das Volume tcms-db-data
# bleibt immer erhalten (Daten, Rollen und Superuser-Passwort).
tcms_remove_containers() {
  local container network
  for container in "$TCMS_API_CONTAINER" "$TCMS_MIGRATE_CONTAINER" "$TCMS_DB_CONTAINER"; do
    docker inspect "$container" >/dev/null 2>&1 || continue
    info "Container $container stoppen und entfernen"
    docker stop --time 30 "$container" >/dev/null || warn "$container liess sich nicht stoppen."
    docker rm "$container" >/dev/null || warn "$container liess sich nicht entfernen."
  done
  for network in "$TCMS_FRONTEND_NETWORK" "$TCMS_BACKEND_NETWORK"; do
    docker network inspect "$network" >/dev/null 2>&1 || continue
    docker network rm "$network" >/dev/null || warn "Netz $network ist noch belegt; nach dem Neustart von app/worker erneut 'tcms disable' ausfuehren."
  done
}

# ---------------------------------------------------------------------------
# Release-Vertrag: deploy, update, rollback
# ---------------------------------------------------------------------------
# Exportiert die TCMS-Pins eines signiert verifizierten Commits fuer den
# laufenden Prozess, wie stage_release_contract die Web-/Worker-Digests.
# .env und STATE aendern sich erst mit dem Last-Good-Vertrag
# (commit_release_contract). Nur der verwaltete Modus braucht die Pins: Fehlen
# sie, bricht der Ablauf vor jedem Backup, jeder Migration und jedem
# Containerwechsel ab.
tcms_stage_release_pins() {
  local commit="$1" mode pins version="" api="" migrate=""
  mode="$(tcms_deployment_mode)" || die "TCMS_DEPLOYMENT muss managed, external oder disabled sein."
  if ! pins="$(tcms_read_release_pins "$commit")"; then
    [[ "$mode" != "managed" ]] || \
      die "TCMS-Pins im signierten Release-Commit ${commit:0:12} sind nicht lesbar; verwaltetes Tax-CMS verweigert."
    pins=""
  fi
  tcms_split_pins "$pins"
  version="$_TCMS_PIN_VERSION"; api="$_TCMS_PIN_API"; migrate="$_TCMS_PIN_MIGRATE"
  if [[ -z "$version" ]]; then
    [[ "$mode" != "managed" ]] || \
      die "Der signierte Release-Stand ${commit:0:12} verankert kein TCMS-Release; TCMS_DEPLOYMENT=managed ist damit nicht betreibbar (./taxtronik tcms disable oder anderen Release waehlen). Es wurde nichts veraendert."
    export TCMS_VERSION="" TCMS_API_DIGEST_SUFFIX="" TCMS_MIGRATE_DIGEST_SUFFIX=""
    return 0
  fi
  export TCMS_VERSION="$version" TCMS_API_DIGEST_SUFFIX="@$api" TCMS_MIGRATE_DIGEST_SUFFIX="@$migrate"
}

# deploy/update: Datenbank -> Migration -> Dienst mit den gestagten Images.
# Wird der neue tcms-api nicht gesund, startet der Last-Good-Stand aus .env
# wieder (wie Signal); der Ablauf bricht dann ab, STATE bleibt Last-Good.
start_tcms_for_deploy() {
  [[ "$(tcms_deployment_mode)" == "managed" ]] || return 0
  local previous_version previous_api previous_migrate
  previous_version="$(get_env TCMS_VERSION)"
  previous_api="$(get_env TCMS_API_DIGEST_SUFFIX)"
  previous_migrate="$(get_env TCMS_MIGRATE_DIGEST_SUFFIX)"
  info "TCMS-Datenbank starten"
  compose --profile tcms up -d --no-deps tcms-db || die "tcms-db konnte nicht gestartet werden."
  tcms_wait_db_healthy
  run_tcms_migrate
  tcms_restart_api && return 0
  warn "Neuer tcms-api wurde nicht healthy; vorherigen Containerstand wiederherstellen."
  if [[ -n "$previous_version" && \
        "$previous_version$previous_api$previous_migrate" != "${TCMS_VERSION:-}${TCMS_API_DIGEST_SUFFIX:-}${TCMS_MIGRATE_DIGEST_SUFFIX:-}" ]]; then
    tcms_restart_api_with "$previous_version" "$previous_api" "$previous_migrate" || \
      warn "Auch der vorherige tcms-api konnte nicht wiederhergestellt werden."
  fi
  return 1
}

# Rollback: Das Ziel muss das verwaltete Tax-CMS kennen; im Release-Kanal
# gelten die Pins seines signiert verifizierten Commits. Merkt den
# Last-Good-Stand fuer die Wiederherstellung (rollback_failure_recover).
tcms_prepare_rollback() {
  local target_commit="$1" current_commit="$2" pins version="" api="" migrate=""
  export _TAXTRONIK_ROLLBACK_TCMS_CHANGED=0
  [[ "$(tcms_deployment_mode)" == "managed" ]] || return 0
  git -C "$ROOT" cat-file -e "${target_commit}:infra/compose/docker-compose.tcms.yml" 2>/dev/null || \
    die "Rollback-Ziel ${target_commit:0:12} kennt das verwaltete Tax-CMS nicht; zuerst ./taxtronik tcms disable (Daten bleiben im Volume tcms-db-data)."
  if images_from_registry; then
    pins="$(tcms_read_release_pins "$current_commit")" || pins=""
    tcms_split_pins "$pins"
    version="$_TCMS_PIN_VERSION"; api="$_TCMS_PIN_API"; migrate="$_TCMS_PIN_MIGRATE"
    export _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_VERSION="$version"
    export _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_API="${api:+@$api}"
    export _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_MIGRATE="${migrate:+@$migrate}"
    tcms_stage_release_pins "$target_commit"
  else
    export _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_VERSION="${TCMS_VERSION:-}"
    export _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_API="" _TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_MIGRATE=""
  fi
}

# Rollback-Aktivierung: tcms-api mit den Ziel-Images, ohne Migrationsschritt
# (Rollback migriert nie). Vor app/worker, damit ein Fehler vor der
# Writer-Aktivierung abbricht.
tcms_rollback_activate() {
  [[ "$(tcms_deployment_mode)" == "managed" ]] || return 0
  export _TAXTRONIK_ROLLBACK_TCMS_CHANGED=1
  tcms_restart_api || die "Rollback abgebrochen: tcms-api mit den Images des Ziel-Releases nicht healthy."
}

tcms_rollback_recover() {
  [[ "${_TAXTRONIK_ROLLBACK_TCMS_CHANGED:-0}" == "1" ]] || return 0
  [[ -n "${_TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_VERSION:-}" ]] || return 0
  tcms_restart_api_with "$_TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_VERSION" \
    "${_TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_API:-}" "${_TAXTRONIK_ROLLBACK_LAST_GOOD_TCMS_MIGRATE:-}" || \
    warn "Last-Good-tcms-api konnte nicht wiederhergestellt werden; ./taxtronik tcms status pruefen."
}

# ---------------------------------------------------------------------------
# Rotation mit Ueberlappung und Wiederaufnahme
# ---------------------------------------------------------------------------
# Zustandsdatei ohne Geheimnisse (0600): Art, Phase, kid bzw. Token-Kennung
# von alt und neu, Zeitpunkte. Neue Geheimnisse liegen bis zur Umstellung als
# *_NEXT in der .env (0600), nie in dieser Datei.
#   prepared  : NEXT erzeugt, neuer Eintrag in der Dienstliste
#   published : tcms-api akzeptiert alt und neu
#   switched  : app/worker nutzen neu (switched_at_epoch); alt wird nach der
#               Wartezeit entfernt
tcms_now() { date -u +%s; }
tcms_sleep() { sleep "$1"; }

_tcms_rotation_value() {
  grep -E "^${1}=" "$TCMS_ROTATION_STATE" | head -n1 | cut -d= -f2- || true
}

tcms_read_rotation_state() {
  local key mode owner
  [[ -f "$TCMS_ROTATION_STATE" && ! -L "$TCMS_ROTATION_STATE" ]] || \
    die "TCMS-Rotationszustand ist keine regulaere Datei: $TCMS_ROTATION_STATE"
  mode="$(stat -c '%a' "$TCMS_ROTATION_STATE" 2>/dev/null || stat -f '%Lp' "$TCMS_ROTATION_STATE")"
  owner="$(stat -c '%u' "$TCMS_ROTATION_STATE" 2>/dev/null || stat -f '%u' "$TCMS_ROTATION_STATE")"
  [[ "$mode" == "600" && "$owner" == "$(id -u)" ]] || \
    die "TCMS-Rotationszustand muss dem Operator gehoeren und Modus 0600 haben: $TCMS_ROTATION_STATE"
  for key in format kind phase old_id new_id created_at_epoch switched_at_epoch; do
    [[ "$(grep -c "^${key}=" "$TCMS_ROTATION_STATE")" == "1" ]] || \
      die "TCMS-Rotationszustand ist beschaedigt ($key); nicht raten, manuell pruefen."
  done
  _TCMS_ROT_KIND="$(_tcms_rotation_value kind)"
  _TCMS_ROT_PHASE="$(_tcms_rotation_value phase)"
  _TCMS_ROT_OLD="$(_tcms_rotation_value old_id)"
  _TCMS_ROT_NEW="$(_tcms_rotation_value new_id)"
  _TCMS_ROT_CREATED="$(_tcms_rotation_value created_at_epoch)"
  _TCMS_ROT_SWITCHED="$(_tcms_rotation_value switched_at_epoch)"
  [[ "$(_tcms_rotation_value format)" == "1" && \
     ( "$_TCMS_ROT_KIND" == "token" || "$_TCMS_ROT_KIND" == "key" ) && \
     "$_TCMS_ROT_PHASE" =~ ^(prepared|published|switched)$ && \
     "$_TCMS_ROT_OLD" =~ ^(tok:[0-9a-f]{16}|[A-Za-z0-9._-]{1,64})$ && \
     "$_TCMS_ROT_NEW" =~ ^(tok:[0-9a-f]{16}|[A-Za-z0-9._-]{1,64})$ && \
     "$_TCMS_ROT_OLD" != "$_TCMS_ROT_NEW" && \
     "$_TCMS_ROT_CREATED" =~ ^[0-9]{10}$ && \
     ( -z "$_TCMS_ROT_SWITCHED" || "$_TCMS_ROT_SWITCHED" =~ ^[0-9]{10}$ ) ]] || \
    die "TCMS-Rotationszustand ist ungueltig; nicht raten, manuell pruefen."
  if [[ "$_TCMS_ROT_PHASE" == "switched" ]]; then
    [[ -n "$_TCMS_ROT_SWITCHED" ]] || die "TCMS-Rotationszustand: Umstellungszeitpunkt fehlt."
  fi
}

tcms_write_rotation_state() {
  local tmp
  tmp="$(mktemp "${TCMS_ROTATION_STATE}.tmp.XXXXXX")" || die "Rotationszustand konnte nicht angelegt werden."
  {
    printf 'format=1\n'
    printf 'kind=%s\n' "$_TCMS_ROT_KIND"
    printf 'phase=%s\n' "$_TCMS_ROT_PHASE"
    printf 'old_id=%s\n' "$_TCMS_ROT_OLD"
    printf 'new_id=%s\n' "$_TCMS_ROT_NEW"
    printf 'created_at_epoch=%s\n' "$_TCMS_ROT_CREATED"
    printf 'switched_at_epoch=%s\n' "$_TCMS_ROT_SWITCHED"
  } >"$tmp"
  chmod 0600 "$tmp" || { rm -f -- "$tmp"; die "Rotationszustand konnte nicht auf 0600 gehaertet werden."; }
  mv -f -- "$tmp" "$TCMS_ROTATION_STATE"
}

tcms_rotation_next_id() {
  if [[ "$_TCMS_ROT_KIND" == "token" ]]; then
    [[ -n "${TCMS_SERVICE_TOKEN_NEXT:-}" ]] && tcms_token_id "$TCMS_SERVICE_TOKEN_NEXT"
  else
    [[ -n "${TCMS_ACTOR_PRIVATE_KEY_NEXT:-}" ]] && printf '%s' "${TCMS_ACTOR_KEY_ID_NEXT:-}"
  fi
  return 0
}

tcms_rotation_current_id() {
  if [[ "$_TCMS_ROT_KIND" == "token" ]]; then tcms_token_id "${TCMS_SERVICE_TOKEN:-}"
  else printf '%s' "${TCMS_ACTOR_KEY_ID:-}"; fi
}

tcms_rotation_clear_next() {
  if [[ "$_TCMS_ROT_KIND" == "token" ]]; then
    [[ -z "$(get_env TCMS_SERVICE_TOKEN_NEXT)" ]] || tcms_set TCMS_SERVICE_TOKEN_NEXT ""
  else
    [[ -z "$(get_env TCMS_ACTOR_PRIVATE_KEY_NEXT)" ]] || tcms_set TCMS_ACTOR_PRIVATE_KEY_NEXT ""
    [[ -z "$(get_env TCMS_ACTOR_KEY_ID_NEXT)" ]] || tcms_set TCMS_ACTOR_KEY_ID_NEXT ""
  fi
}

# Aktuelle Konfiguration muss konsistent sein, bevor rotiert wird.
tcms_assert_rotation_baseline() {
  local kind="$1" public
  if [[ "$kind" == "token" ]]; then
    tcms_valid_token "${TCMS_SERVICE_TOKEN:-}" || die "TCMS_SERVICE_TOKEN hat kein gueltiges Format."
    tcms_valid_token_list "${TCMS_SERVICE_TOKENS:-}" || die "TCMS_SERVICE_TOKENS ist ungueltig."
    [[ "${TCMS_SERVICE_TOKENS}" == "${TCMS_SERVICE_TOKEN}" ]] || \
      die "TCMS_SERVICE_TOKENS muss vor einer Rotation genau das aktuelle Token enthalten (./taxtronik tcms status)."
  else
    tcms_valid_public_key_list "${TCMS_ACTOR_PUBLIC_KEYS:-}" || die "TCMS_ACTOR_PUBLIC_KEYS ist ungueltig."
    public="$(tcms_public_key_for_private "${TCMS_ACTOR_PRIVATE_KEY:-}")" || \
      die "TCMS_ACTOR_PRIVATE_KEY ist kein PKCS#8-Ed25519-Schluessel."
    [[ "${TCMS_ACTOR_PUBLIC_KEYS}" == "${TCMS_ACTOR_KEY_ID:-}=${public}" ]] || \
      die "TCMS_ACTOR_PUBLIC_KEYS muss vor einer Rotation genau den aktuellen Schluessel enthalten (./taxtronik tcms status)."
  fi
}

tcms_rotation_begin() {
  local kind="$1" token
  tcms_assert_rotation_baseline "$kind"
  _TCMS_ROT_KIND="$kind"; _TCMS_ROT_PHASE="prepared"
  _TCMS_ROT_CREATED="$(tcms_now)"; _TCMS_ROT_SWITCHED=""
  if [[ "$kind" == "token" ]]; then
    token="$(tcms_generate_token "$TCMS_SERVICE_TOKEN")"
    _TCMS_ROT_OLD="$(tcms_token_id "$TCMS_SERVICE_TOKEN")"; _TCMS_ROT_NEW="$(tcms_token_id "$token")"
    tcms_write_rotation_state
    tcms_set TCMS_SERVICE_TOKEN_NEXT "$token"
  else
    tcms_generate_keypair "$TCMS_ACTOR_PUBLIC_KEYS"
    _TCMS_ROT_OLD="$TCMS_ACTOR_KEY_ID"; _TCMS_ROT_NEW="$_TCMS_GEN_KID"
    tcms_write_rotation_state
    tcms_set TCMS_ACTOR_KEY_ID_NEXT "$_TCMS_GEN_KID"
    tcms_set TCMS_ACTOR_PRIVATE_KEY_NEXT "$_TCMS_GEN_PRIVATE"
    unset _TCMS_GEN_PRIVATE
  fi
  info "Rotation vorbereitet: ${_TCMS_ROT_OLD} -> ${_TCMS_ROT_NEW}"
}

# Phase prepared: neuen Eintrag veroeffentlichen und tcms-api neu starten.
tcms_rotation_publish() {
  local next_id public
  next_id="$(tcms_rotation_next_id)"
  if [[ "$next_id" != "$_TCMS_ROT_NEW" ]]; then
    # Abbruch vor dem Schreiben des neuen Werts: nichts wurde veroeffentlicht.
    warn "Unterbrochene Vorbereitung ohne neuen Wert gefunden; Rotation beginnt neu."
    tcms_rotation_clear_next
    rm -f -- "$TCMS_ROTATION_STATE"
    tcms_rotation_begin "$_TCMS_ROT_KIND"
    next_id="$_TCMS_ROT_NEW"
  fi
  if [[ "$_TCMS_ROT_KIND" == "token" ]]; then
    tcms_token_list_contains "${TCMS_SERVICE_TOKENS:-}" "$TCMS_SERVICE_TOKEN_NEXT" || \
      tcms_set TCMS_SERVICE_TOKENS "${TCMS_SERVICE_TOKENS:+$TCMS_SERVICE_TOKENS,}$TCMS_SERVICE_TOKEN_NEXT"
    tcms_valid_token_list "$TCMS_SERVICE_TOKENS" || die "TCMS_SERVICE_TOKENS waere ungueltig; Rotation angehalten."
  else
    public="$(tcms_public_key_for_private "$TCMS_ACTOR_PRIVATE_KEY_NEXT")" || \
      die "Neuer privater Schluessel ist ungueltig; Rotation angehalten."
    [[ -n "$(tcms_public_key_of_kid "${TCMS_ACTOR_PUBLIC_KEYS:-}" "$next_id")" ]] || \
      tcms_set TCMS_ACTOR_PUBLIC_KEYS "${TCMS_ACTOR_PUBLIC_KEYS:+$TCMS_ACTOR_PUBLIC_KEYS,}${next_id}=${public}"
    [[ "$(tcms_public_key_of_kid "$TCMS_ACTOR_PUBLIC_KEYS" "$next_id")" == "$public" ]] || \
      die "kid $next_id ist mit einem anderen Schluessel gelistet; Rotation angehalten."
    tcms_valid_public_key_list "$TCMS_ACTOR_PUBLIC_KEYS" || die "TCMS_ACTOR_PUBLIC_KEYS waere ungueltig; Rotation angehalten."
  fi
  tcms_restart_api || die "tcms-api mit alt+neu nicht healthy; Rotation bleibt in Phase prepared (erneut ausfuehren)."
  _TCMS_ROT_PHASE="published"
  tcms_write_rotation_state
  info "tcms-api akzeptiert alten und neuen Wert."
}

# Phase published: app/worker umstellen (idempotent), Zeitpunkt festhalten.
tcms_rotation_switch() {
  if [[ "$(tcms_rotation_current_id)" != "$_TCMS_ROT_NEW" ]]; then
    [[ "$(tcms_rotation_next_id)" == "$_TCMS_ROT_NEW" ]] || \
      die "Neuer Wert fehlt in .env, app/worker sind nicht umgestellt; Rotation nicht fortsetzbar (manuell pruefen)."
    if [[ "$_TCMS_ROT_KIND" == "token" ]]; then
      tcms_set TCMS_SERVICE_TOKEN "$TCMS_SERVICE_TOKEN_NEXT"
    else
      tcms_set TCMS_ACTOR_PRIVATE_KEY "$TCMS_ACTOR_PRIVATE_KEY_NEXT"
      tcms_set TCMS_ACTOR_KEY_ID "$TCMS_ACTOR_KEY_ID_NEXT"
    fi
  elif [[ "$_TCMS_ROT_KIND" == "key" && -n "${TCMS_ACTOR_PRIVATE_KEY_NEXT:-}" ]]; then
    # Abbruch zwischen den beiden Schreibvorgaengen: Paar vervollstaendigen.
    tcms_set TCMS_ACTOR_PRIVATE_KEY "$TCMS_ACTOR_PRIVATE_KEY_NEXT"
  fi
  tcms_restart_writers
  _TCMS_ROT_PHASE="switched"
  _TCMS_ROT_SWITCHED="$(tcms_now)"
  tcms_write_rotation_state
  tcms_rotation_clear_next
}

tcms_wait_until() {
  local deadline="$1" now remaining last=-1
  while :; do
    now="$(tcms_now)"
    (( now >= deadline )) && return 0
    remaining=$(( deadline - now ))
    if (( last < 0 || last - remaining >= 30 )); then
      info "Ueberlappung: alter Wert bleibt noch ${remaining} s gueltig (Abbruch moeglich; erneuter Aufruf setzt die Wartezeit fort)."
      last="$remaining"
    fi
    tcms_sleep "$(( remaining < 5 ? remaining : 5 ))"
  done
}

# Phase switched: nach der Wartezeit alten Eintrag entfernen, tcms-api neu.
tcms_rotation_retire() {
  local min_wait list entry kept="" current_id
  local -a entries
  tcms_rotation_clear_next
  current_id="$(tcms_rotation_current_id)"
  [[ "$current_id" == "$_TCMS_ROT_NEW" && "$_TCMS_ROT_OLD" != "$current_id" ]] || \
    die "Aktueller Wert ist nicht der neue ($current_id); alter Eintrag wird nicht entfernt."
  if [[ "$_TCMS_ROT_KIND" == "key" ]]; then min_wait="$TCMS_KEY_ROTATION_MIN_WAIT"; else min_wait="$TCMS_TOKEN_ROTATION_MIN_WAIT"; fi
  tcms_wait_until $(( _TCMS_ROT_SWITCHED + min_wait ))
  if [[ "$_TCMS_ROT_KIND" == "token" ]]; then
    list="${TCMS_SERVICE_TOKENS:-}"
    IFS=',' read -r -a entries <<<"$list"
    for entry in "${entries[@]}"; do
      [[ "$(tcms_token_id "$entry")" == "$_TCMS_ROT_OLD" ]] || kept+="${kept:+,}$entry"
    done
    tcms_token_list_contains "$kept" "$TCMS_SERVICE_TOKEN" || die "Aktuelles Token fehlt in der Liste; nichts entfernt."
    [[ "$kept" == "$list" ]] || tcms_set TCMS_SERVICE_TOKENS "$kept"
  else
    list="${TCMS_ACTOR_PUBLIC_KEYS:-}"
    IFS=',' read -r -a entries <<<"$list"
    for entry in "${entries[@]}"; do
      [[ "${entry%%=*}" == "$_TCMS_ROT_OLD" ]] || kept+="${kept:+,}$entry"
    done
    [[ -n "$(tcms_public_key_of_kid "$kept" "$TCMS_ACTOR_KEY_ID")" ]] || die "Aktueller Schluessel fehlt in der Liste; nichts entfernt."
    [[ "$kept" == "$list" ]] || tcms_set TCMS_ACTOR_PUBLIC_KEYS "$kept"
  fi
  tcms_restart_api || die "tcms-api nach dem Entfernen nicht healthy; erneut ausfuehren (Zustand bleibt)."
  rm -f -- "$TCMS_ROTATION_STATE"
  info "Rotation abgeschlossen: ${_TCMS_ROT_OLD} entfernt, ${_TCMS_ROT_NEW} aktiv."
}

cmd_tcms_rotate() {
  local kind="$1"
  load_env
  [[ "$(tcms_deployment_mode)" == "managed" ]] || \
    die "rotate-$kind gilt fuer TCMS_DEPLOYMENT=managed. Externes Tax-CMS: docs/operations/secret-rotation.md (Abschnitt Tax-CMS)."
  if [[ -e "$TCMS_ROTATION_STATE" ]]; then
    tcms_read_rotation_state
    [[ "$_TCMS_ROT_KIND" == "$kind" ]] || \
      die "Eine Rotation ($_TCMS_ROT_KIND) ist nicht abgeschlossen; zuerst ./taxtronik tcms rotate-$_TCMS_ROT_KIND erneut ausfuehren."
    info "Unterbrochene Rotation wird fortgesetzt (Phase $_TCMS_ROT_PHASE)."
  else
    tcms_rotation_begin "$kind"
  fi
  [[ "$_TCMS_ROT_PHASE" != "prepared" ]] || tcms_rotation_publish
  [[ "$_TCMS_ROT_PHASE" != "published" ]] || tcms_rotation_switch
  tcms_rotation_retire
}

# ---------------------------------------------------------------------------
# Kommandos
# ---------------------------------------------------------------------------
cmd_tcms_setup() {
  local requested="${1:-}" start=1 current mode choice=""
  [[ "${2:-}" == "--no-start" || "${1:-}" == "--no-start" ]] && start=0
  [[ "$requested" == "--no-start" ]] && requested="${2:-}"
  load_env
  [[ ! -e "$TCMS_ROTATION_STATE" ]] || die "Eine TCMS-Rotation ist nicht abgeschlossen; zuerst fortsetzen (./taxtronik tcms status)."
  current="$(tcms_deployment_mode)" || die "TCMS_DEPLOYMENT in .env ist ungueltig."
  mode="$requested"
  if [[ -z "$mode" ]]; then
    [[ -t 0 ]] || die "Nutzung: ./taxtronik tcms setup managed|external|disabled [--no-start]"
    printf '\nTax-CMS einrichten (aktuell: %s)\n' "$current"
    printf '  1) Mit TaxTronik verwalten (eigene Datenbank, interne Netze)\n'
    printf '  2) Externes Tax-CMS anbinden (HTTPS)\n'
    printf '  3) Deaktivieren\n'
    read -rp 'Auswahl: ' choice || true
    case "$choice" in
      1|managed) mode=managed ;;
      2|external) mode=external ;;
      3|disabled) mode=disabled ;;
      *) die "Ungueltige Auswahl: $choice" ;;
    esac
  fi
  case "$mode" in
    managed)
      tcms_configure_managed
      if (( start == 1 )) && tcms_installed; then
        tcms_activate
        info "Tax-CMS verwaltet und aktiv."
      else
        info "Tax-CMS ist konfiguriert (managed); Start mit ./taxtronik deploy."
      fi
      ;;
    external)
      [[ "$current" != "managed" ]] || die "Vom verwalteten Modus zuerst ./taxtronik tcms disable ausfuehren (Daten bleiben im Volume tcms-db-data)."
      tcms_configure_external
      if (( start == 1 )) && tcms_installed; then tcms_restart_writers; fi
      info "Externes Tax-CMS angebunden."
      ;;
    disabled) cmd_tcms_disable ;;
    *) die "Nutzung: ./taxtronik tcms setup managed|external|disabled [--no-start]" ;;
  esac
}

# Erwartet geladene .env (Dispatcher bzw. cmd_tcms_setup).
cmd_tcms_disable() {
  local key
  [[ ! -e "$TCMS_ROTATION_STATE" ]] || die "Eine TCMS-Rotation ist nicht abgeschlossen; zuerst fortsetzen oder den Zustand pruefen."
  tcms_set TCMS_DEPLOYMENT disabled
  for key in TCMS_URL TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY TCMS_ACTOR_KEY_ID \
    TCMS_SERVICE_TOKENS TCMS_ACTOR_PUBLIC_KEYS TCMS_SERVICE_TOKEN_NEXT \
    TCMS_ACTOR_PRIVATE_KEY_NEXT TCMS_ACTOR_KEY_ID_NEXT; do
    [[ -z "$(get_env "$key")" && -z "${!key:-}" ]] || tcms_set "$key" ""
  done
  # Erst app/worker ohne TCMS neu starten, dann den Dienst entfernen.
  if tcms_installed; then tcms_restart_writers; fi
  tcms_remove_containers
  info "Tax-CMS deaktiviert. Das Volume tcms-db-data und TCMS_DB_* bleiben erhalten (Daten, Rollen); Loeschen nur bewusst von Hand."
}

cmd_tcms_status() {
  local mode container cstate network networks
  load_env
  mode="$(tcms_deployment_mode)" || { echo "TCMS_DEPLOYMENT: ungueltig"; return 1; }
  printf 'Modus            : %s\n' "$mode"
  case "$mode" in
    disabled) ;;
    external)
      printf 'URL              : %s\n' "${TCMS_URL:-<fehlt>}"
      printf 'Akteurs-kid      : %s\n' "${TCMS_ACTOR_KEY_ID:-<fehlt>}"
      ;;
    managed)
      printf 'Images           : tcms-api/tcms-migrate:%s%s\n' "${TCMS_VERSION:-<fehlt>}" \
        "$([[ -n "${TCMS_API_DIGEST_SUFFIX:-}" ]] && printf ' (per Digest)' || printf ' (lokal)')"
      printf 'Dienst-Tokens    : %s Eintrag/Eintraege, aktuelles Token %s\n' \
        "$(tr ',' '\n' <<<"${TCMS_SERVICE_TOKENS:-}" | grep -c .)" \
        "$(tcms_token_list_contains "${TCMS_SERVICE_TOKENS:-}" "${TCMS_SERVICE_TOKEN:-}" && printf 'gelistet' || printf 'NICHT gelistet')"
      printf 'Schluessel (kid) : %s; aktiv: %s\n' "$(tcms_kids_of_list "${TCMS_ACTOR_PUBLIC_KEYS:-}")" "${TCMS_ACTOR_KEY_ID:-<fehlt>}"
      for container in "$TCMS_DB_CONTAINER" "$TCMS_MIGRATE_CONTAINER" "$TCMS_API_CONTAINER"; do
        cstate="$(docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || printf 'fehlt')"
        printf '%-17s: %s\n' "${container#taxtronik-}" "$cstate"
      done
      for container in taxtronik-app taxtronik-worker; do
        networks="$(docker inspect --format '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container" 2>/dev/null || true)"
        printf '%-17s: Netze %s\n' "${container#taxtronik-}" "${networks:-<laeuft nicht>}"
      done
      for network in "$TCMS_BACKEND_NETWORK" "$TCMS_FRONTEND_NETWORK"; do
        printf '%-17s: internal=%s\n' "$network" "$(docker network inspect --format '{{.Internal}}' "$network" 2>/dev/null || printf 'fehlt')"
      done
      ;;
  esac
  if [[ -e "$TCMS_ROTATION_STATE" ]]; then
    tcms_read_rotation_state
    printf 'Rotation         : %s in Phase %s (%s -> %s); fortsetzen mit ./taxtronik tcms rotate-%s\n' \
      "$_TCMS_ROT_KIND" "$_TCMS_ROT_PHASE" "$_TCMS_ROT_OLD" "$_TCMS_ROT_NEW" "$_TCMS_ROT_KIND"
  fi
}

cmd_tcms() {
  local sub="${1:-help}"
  shift || true
  case "$sub" in
    setup) cmd_tcms_setup "$@" ;;
    status) cmd_tcms_status ;;
    rotate-token) cmd_tcms_rotate token ;;
    rotate-key) cmd_tcms_rotate key ;;
    disable) load_env; cmd_tcms_disable ;;
    help|-h|--help)
      cat <<'USAGE'
./taxtronik tcms setup [managed|external|disabled] [--no-start]
./taxtronik tcms status
./taxtronik tcms rotate-token     Dienst-Token mit Ueberlappung tauschen (managed)
./taxtronik tcms rotate-key       Akteursschluessel mit Ueberlappung tauschen (managed, >= 5 min)
./taxtronik tcms disable          Tax-CMS abschalten (Volume bleibt)
USAGE
      ;;
    *) die "Unbekanntes tcms-Kommando: $sub (./taxtronik tcms help)" ;;
  esac
}
