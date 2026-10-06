#!/usr/bin/env bash
# =============================================================================
# docker-compose-Wrapper — Teil der Operator-CLI (./taxtronik).
#
# compose (ehemals ./dc) mit Image-Pin-Guard und S3-Config sowie der Abgleich
# des n8n-Verschluesselungsschluessels mit dem vorhandenen n8n-Volume.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
  # Fallback und Zweitversuch nur mit dem digest-gepinnten Alpine-Helfer.
  image="${image:-${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}}"
  docker run --rm --entrypoint node -v "$volume:/data:ro" "$image" -p \
    "const fs=require('fs'); const p='/data/config'; fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p,'utf8')).encryptionKey || '') : ''" \
    2>/dev/null || \
  docker run --rm -v "$volume:/data:ro" "${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}" sh -c \
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
