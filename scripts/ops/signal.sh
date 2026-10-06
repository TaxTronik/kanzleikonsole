#!/usr/bin/env bash
# =============================================================================
# Signal (Risk-Layer) — Teil der Operator-CLI (./taxtronik).
#
# Besitzvertrag managed/external/disabled, Source-Build aus gepinntem Git-Ref,
# Image-Pruefung, CPU-LLM-Provisionierung, Start mit Rueckfall und die
# interaktive Konfiguration.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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

# Branch, Tag oder Commit ohne Optionen-, Revisions- oder Shell-Syntax. Gilt fuer
# SIGNAL_GIT_REF und TAXTRONIK_UPDATE_REF.
valid_git_ref() {
  local value="${1:-}"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && \
     "$value" != *..* && "$value" != *//* && "$value" != *@\{* && \
     "$value" != */ && "$value" != *\.lock ]]
}

valid_signal_git_ref() { valid_git_ref "$@"; }

# commit = unveraenderlicher, vollstaendiger Commit-SHA; tag = explizites
# refs/tags/<Tag> (nur so fest wie der Tag-Schutz auf dem Server); moving =
# Branch oder mehrdeutiger Kurzname, der bei jedem Update weiterwandern kann.
signal_git_ref_kind() {
  local value="${1:-}"
  if [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then printf 'commit'
  elif [[ "$value" == refs/tags/?* ]]; then printf 'tag'
  else printf 'moving'; fi
}

signal_source_dir() {
  local configured="${SIGNAL_GIT_DIR:-$(get_env SIGNAL_GIT_DIR)}"
  if [[ -n "$configured" ]]; then
    printf '%s' "$configured"
  else
    printf '%s/signal' "$(dirname "$ROOT")"
  fi
}

signal_llm_dir() {
  local configured="${SIGNAL_LLM_DIR:-$(get_env SIGNAL_LLM_DIR)}"
  printf '%s' "${configured:-$ROOT/.taxtronik/signal-llm}"
}

validate_signal_llm_dir() {
  local dir="${1:-}"
  [[ "$dir" == /* && "$dir" != "/" && "$dir" != "$ROOT" && ! -L "$dir" ]]
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
  local channel resolved llm_dir
  llm_dir="$(signal_llm_dir)"
  validate_signal_llm_dir "$llm_dir" || \
    die "SIGNAL_LLM_DIR muss ein absolutes, nicht verlinktes Verzeichnis sein (nicht / oder Repository-Wurzel)."
  export SIGNAL_LLM_DIR="$llm_dir"
  export RISK_LAYER_LLM_BACKEND="${RISK_LAYER_LLM_BACKEND:-cpu}"
  export RISK_LAYER_LLM_TIMEOUT="${RISK_LAYER_LLM_TIMEOUT:-$SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT}"
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
  valid_signal_git_ref "$ref" || \
    die "SIGNAL_GIT_REF fehlt oder ist ungueltig. Vollstaendigen Signal-Commit-SHA (empfohlen) oder refs/tags/<Tag> setzen; ein beweglicher Branch wird nicht mehr implizit gebaut."
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
  case "$(signal_git_ref_kind "$ref")" in
    commit)
      [[ "$sha" == "$ref" ]] || die "Signal-Checkout entspricht nicht dem gepinnten Commit $ref."
      ;;
    moving)
      warn "SIGNAL_GIT_REF '$ref' ist beweglich; gebaut wird der aktuelle Stand ${sha:0:12}. Fuer kontrollierte Updates einen vollstaendigen Commit-SHA setzen."
      ;;
  esac
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

provision_signal_managed_llm() {
  local image="$1" dir cpu_count="" mem_total_kib="" memory_limit="1g" size_gib=""
  dir="$(signal_llm_dir)"
  validate_signal_llm_dir "$dir" || \
    die "SIGNAL_LLM_DIR muss ein absolutes, nicht verlinktes Verzeichnis sein (nicht / oder Repository-Wurzel)."
  [[ -f "$ROOT/scripts/provision-signal-llm.py" ]] || \
    die "scripts/provision-signal-llm.py fehlt; verwaltetes Signal darf ohne gepinntes CPU-LLM nicht starten."
  install -d -m 0755 "$dir" || die "Signal-LLM-Verzeichnis konnte nicht angelegt werden: $dir"

  if [[ -r /proc/meminfo ]]; then
    mem_total_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
    if [[ "$mem_total_kib" =~ ^[0-9]+$ ]] && (( mem_total_kib < 16 * 1024 * 1024 )); then
      warn "CPU-LLM-Bottleneck: weniger als 16 GiB Host-RAM erkannt. Das Modell ist funktionsfaehig, kann unter Parallelbetrieb aber stark ausbremsen oder an Speichergrenzen stossen."
    fi
  fi
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  if [[ "$cpu_count" =~ ^[0-9]+$ ]] && (( cpu_count < 4 )); then
    warn "CPU-LLM-Bottleneck: nur $cpu_count logische CPUs erkannt; Vertiefungen koennen deutlich mehrere Minuten dauern."
  fi

  size_gib="$(awk -v bytes="$SIGNAL_MANAGED_LLM_SIZE_BYTES" 'BEGIN { printf "%.1f", bytes / 1024 / 1024 / 1024 }')"
  info "Lokale KI-Vertiefung provisionieren: $SIGNAL_MANAGED_LLM_MODEL (CPU, ${size_gib} GiB)"
  info "Performance-Hinweis: Ohne GPU ist die generative Vertiefung der erwartete Bottleneck; Signal-Kern und Embeddings bleiben davon unabhängig nutzbar."
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --memory "$memory_limit" --memory-swap "$memory_limit" \
    -e LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/torch/lib \
    -v "$dir:/managed-llm" \
    -v "$ROOT/scripts/provision-signal-llm.py:/opt/taxtronik/provision-signal-llm.py:ro" \
    --entrypoint python \
    "$image" /opt/taxtronik/provision-signal-llm.py --output /managed-llm || \
    die "Signal CPU-LLM konnte nicht vollständig und integer provisioniert werden; laufender Dienst bleibt unverändert."

  export SIGNAL_LLM_DIR="$dir"
  export RISK_LAYER_LLM_BACKEND="cpu"
  export RISK_LAYER_LLM_TIMEOUT="$SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT"
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
  # Erst den Signal-Kern, dann die getrennt update-stabilen LLM-Artefakte
  # prüfen. Beides geschieht vor dem Austausch des laufenden Dienstes.
  verify_signal_managed_image "$image" "$channel"
  provision_signal_managed_llm "$image"
}

start_signal_for_deploy() {
  [[ "$(signal_deployment_mode)" == "managed" ]] || return 0
  prepare_signal_managed_environment
  local previous_image=""
  previous_image="$(docker inspect --format '{{.Config.Image}}' taxtronik-risk-layer 2>/dev/null || true)"
  info "Verwaltetes Signal starten und API-Liveness pruefen"
  if compose --profile risk-layer up -d --force-recreate --no-deps \
      --wait --wait-timeout 300 risk-layer; then
    if [[ "$(signal_deploy_channel)" == "source" ]]; then
      set_env SIGNAL_IMAGE "$SIGNAL_IMAGE"
    fi
    return 0
  fi

  warn "Signal-Startdiagnose (keine Secrets): Containerstatus und letzte Engine-Logs folgen."
  compose --profile risk-layer ps risk-layer >&2 || true
  docker inspect --format \
    '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{printf "%q" .Output}}{{println}}{{end}}' \
    taxtronik-risk-layer >&2 2>/dev/null || true
  compose --profile risk-layer logs --no-color --tail 120 risk-layer >&2 || true
  warn "Neues Signal-Release wurde nicht bereit; versuche den vorherigen Containerstand wiederherzustellen."
  if [[ -n "$previous_image" && "$previous_image" != "$SIGNAL_IMAGE" ]]; then
    export SIGNAL_IMAGE="$previous_image"
    compose --profile risk-layer up -d --force-recreate --no-deps \
      --wait --wait-timeout 300 risk-layer \
      || warn "Auch der vorherige Signal-Container konnte nicht wiederhergestellt werden."
  fi
  return 1
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
  SIGNAL_LLM_DIR="${SIGNAL_LLM_DIR:-$ROOT/.taxtronik/signal-llm}"
  RISK_LAYER_EMB_DEVICE="${RISK_LAYER_EMB_DEVICE:-cpu}"
  RISK_LAYER_LLM_BACKEND="${RISK_LAYER_LLM_BACKEND:-auto}"
  RISK_LAYER_LLM_TIMEOUT="${RISK_LAYER_LLM_TIMEOUT:-}"

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
        prompt "Signal-Git-Ref (vollstaendiger Commit-SHA empfohlen, alternativ refs/tags/<Tag>)" SIGNAL_GIT_REF "$SIGNAL_GIT_REF_DEFAULT"
        prompt "Lokaler Signal-Checkout" SIGNAL_GIT_DIR "$(dirname "$ROOT")/signal"
        valid_signal_git_url "$SIGNAL_GIT_URL" || \
          die "Signal-Git-URL ist ungueltig oder enthaelt eingebettete Zugangsdaten."
        valid_signal_git_ref "$SIGNAL_GIT_REF" || \
          die "SIGNAL_GIT_REF fehlt oder ist ungueltig; vollstaendigen Signal-Commit-SHA (empfohlen) oder refs/tags/<Tag> in .env setzen."
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
        RISK_LAYER_OPERATOR_TOKEN=""
        for _ in 1 2 3; do
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
      validate_signal_llm_dir "$SIGNAL_LLM_DIR" || \
        die "SIGNAL_LLM_DIR muss ein absolutes, nicht verlinktes Verzeichnis sein."
      RISK_LAYER_LLM_BACKEND="cpu"
      RISK_LAYER_LLM_TIMEOUT="$SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT"
      info "Signal wird durch TaxTronik verwaltet ($channel); Kern, CPU-LLM und getrennte Secrets werden automatisch provisioniert."
      warn "CPU-LLM ist funktionsfaehig, aber der erwartete Performance-Bottleneck; Vertiefungen koennen mehrere Minuten dauern."
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
      SIGNAL_LLM_DIR=""
      RISK_LAYER_LLM_BACKEND="auto"
      RISK_LAYER_LLM_TIMEOUT=""
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
      SIGNAL_LLM_DIR=""
      RISK_LAYER_LLM_BACKEND="auto"
      RISK_LAYER_LLM_TIMEOUT=""
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
  set_env SIGNAL_LLM_DIR "$SIGNAL_LLM_DIR"
  set_env RISK_LAYER_LLM_BACKEND "$RISK_LAYER_LLM_BACKEND"
  set_env RISK_LAYER_LLM_TIMEOUT "$RISK_LAYER_LLM_TIMEOUT"
  # Bestandswert wird nur aus der Env entfernt; Host-Daten werden niemals
  # geloescht. Verwaltete Images tragen ihr Festwissen selbst, externe Dienste
  # besitzen ihre Daten ohnehin ausserhalb von TaxTronik.
  set_env RISK_LAYER_FESTWISSEN_DIR ""
}
