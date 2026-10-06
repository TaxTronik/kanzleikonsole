#!/usr/bin/env bash
# =============================================================================
# ./taxtronik rollback — Teil der Operator-CLI (./taxtronik).
#
# DB-Kompatibilitaets-Gates und Ruecksprung mit automatischer
# Last-Good-Wiederherstellung.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

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
    # shellcheck disable=SC2034 # UPDATE_* liest stage_release_contract (release.sh)
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
