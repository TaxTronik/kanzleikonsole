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
  { read -r pinned_version; read -r pinned_api; read -r pinned_migrate; } <<<"$pins"
  [[ -n "$pinned_version" ]] || \
    die "Registry-Compose verweigert: Der verifizierte Release-Stand verankert kein TCMS-Release; TCMS_DEPLOYMENT=managed ist so nicht betreibbar (./taxtronik tcms disable oder Update auf einen Release mit TCMS)."
  [[ "$version" == "$pinned_version" && "$api_suffix" == "@$pinned_api" && \
     "$migrate_suffix" == "@$pinned_migrate" ]] || \
    die "Registry-Compose verweigert: TCMS-Images in .env/Prozess weichen vom signierten Release-Stand ab. deploy/update/rollback verwenden."
}
