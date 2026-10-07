#!/usr/bin/env bash
# =============================================================================
# Bezugsweg und Release-Vertrag — Teil der Operator-CLI (./taxtronik).
#
# Source-/Release-Kanal, signiertes Update-Manifest, Release-Tags, Image-Build
# mit RAM-Schutz, Image-Pull und OCI-Label-Pruefung.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
  # Zweite Sperre hinter refuse_source_channel_in_production (deploy/update):
  # Nach load_env baut oder aktiviert kein Pfad einen Source-Stand in
  # Produktion, auch nicht nach einem Operator-Handoff.
  if operator_is_production; then
    die "Source-Kanal in Produktion verweigert. $(production_release_channel_hint)"
  fi
  export TAXTRONIK_DEPLOY_CHANNEL=source
  export TAXTRONIK_IMAGE_PREFIX=taxtronik
  local version
  version="$(source_version_for_checkout)"
  export TAXTRONIK_VERSION="$version"
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
  # shellcheck disable=SC2015 # gewollt: die, sobald eine der beiden Pruefungen scheitert
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
  # shellcheck disable=SC2015 # gewollt: die, sobald eine der beiden Pruefungen scheitert
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
  memory_limit="${TAXTRONIK_BUILD_MEMORY_LIMIT:-6g}"
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
