#!/usr/bin/env bash
# =============================================================================
# ./taxtronik restore — Teil der Operator-CLI (./taxtronik).
#
# Argumentpruefung vor jeder Seitenwirkung, Restore-Lauf und
# Produktions-Restore mit gestoppten Writern.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

PRODUCTION_RESTORE_CONFIRMATION="RESTORE_TAXTRONIK_PRODUCTION_DATABASE"
RESTORE_LIST_ONLY=0
RESTORE_PRODUCTION_TARGET=0
RESTORE_RELEASE_VERSION=""

# Validiert den Restore-Aufruf VOR jedem start/stop und damit vor jeder
# Seitenauswirkung des Operator-Wrappers. restore.ts prueft dieselben Regeln
# nochmals fuer direkte TypeScript-Aufrufe.
validate_restore_args() {
  local seen=" " option_count=0 source_count=0 target_count=0
  local list_only=0 production_target=0 production_confirmation="" release_version="" arg value

  while (( $# > 0 )); do
    arg="$1"
    case " $seen " in
      *" $arg "*) die "Restore-Option doppelt angegeben: $arg" ;;
    esac

    case "$arg" in
      --list)
        seen+="$arg "; option_count=$((option_count + 1)); list_only=1; shift
        ;;
      --latest)
        seen+="$arg "; option_count=$((option_count + 1)); source_count=$((source_count + 1)); shift
        ;;
      --key|--file)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        seen+="$arg "; option_count=$((option_count + 1)); source_count=$((source_count + 1)); shift 2
        ;;
      --target-url)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        value="$2"
        [[ "$value" == postgres://* || "$value" == postgresql://* ]] || \
          die "--target-url muss mit postgres:// oder postgresql:// beginnen."
        seen+="$arg "; option_count=$((option_count + 1)); target_count=$((target_count + 1)); shift 2
        ;;
      --production-target)
        seen+="$arg "; option_count=$((option_count + 1)); target_count=$((target_count + 1)); production_target=1; shift
        ;;
      --confirm-production-restore)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        production_confirmation="$2"
        seen+="$arg "; option_count=$((option_count + 1)); shift 2
        ;;
      --release-version)
        [[ $# -ge 2 && -n "${2:-}" && "$2" != --* ]] || die "$arg erwartet genau einen nicht-leeren Wert."
        release_version="$2"
        seen+="$arg "; option_count=$((option_count + 1)); shift 2
        ;;
      --confirm-overwrite|--no-smoke-test)
        seen+="$arg "; option_count=$((option_count + 1)); shift
        ;;
      *)
        die "Unbekannte Restore-Option: $arg"
        ;;
    esac
  done

  if (( list_only == 1 )); then
    (( option_count == 1 )) || die "--list ist read-only und darf nicht mit weiteren Optionen kombiniert werden."
  else
    (( source_count == 1 )) || \
      die "Genau eine Restore-Quelle ist Pflicht: --latest, --key <s3-key> oder --file <pfad>."
    (( target_count == 1 )) || \
      die "Genau ein Restore-Ziel ist Pflicht: --target-url <postgres-url> oder --production-target."
    if (( production_target == 1 )); then
      [[ "$production_confirmation" == "$PRODUCTION_RESTORE_CONFIRMATION" ]] || \
        die "--production-target erfordert die exakte Bestaetigung: --confirm-production-restore $PRODUCTION_RESTORE_CONFIRMATION"
      [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
        die "--production-target erfordert --release-version X.Y.Z passend zum wiederhergestellten Backup."
    else
      [[ -z "$production_confirmation" ]] || \
        die "--confirm-production-restore ist nur zusammen mit --production-target erlaubt."
      [[ -z "$release_version" ]] || \
        die "--release-version ist nur zusammen mit --production-target erlaubt."
    fi
  fi

  RESTORE_LIST_ONLY="$list_only"
  RESTORE_PRODUCTION_TARGET="$production_target"
  RESTORE_RELEASE_VERSION="$release_version"
}

restore_needs_s3() {
  local arg
  for arg in "$@"; do
    [[ "$arg" == "--file" ]] && return 1
  done
  return 0
}

run_restore() {
  require_cmd pnpm
  info "Restore starten"
  generate_prisma_client_for_host_tools
  if ! command -v pg_restore >/dev/null 2>&1; then
    export PG_RESTORE_PATH="$ROOT/infra/scripts/pg_restore-via-container.sh"
    info "pg_restore fehlt auf dem Host -> nutze pg_restore aus dem Postgres-Container (PG_RESTORE_PATH)."
  fi
  if restore_needs_s3 "$@"; then
    if [[ "${RESTORE_LIST_ONLY:-0}" == "1" ]]; then
      # --list ist strikt read-only: keine Container starten, keine Credentials
      # neu laden und keine Buckets initialisieren. Ist S3 nicht erreichbar,
      # endet der Aufruf mit einer klaren Betriebsanweisung.
      s3_preflight || die "Read-only Restore-Liste konnte S3 nicht erreichen. Stack zuerst separat starten; --list veraendert keinen Dienstzustand."
    else
      ensure_s3_ready_for_backup
    fi
  fi
  ( cd "$ROOT" && pnpm --filter @taxtronik/web backup:restore -- "$@" )
}

assert_restore_writers_stopped() {
  local container running
  for container in taxtronik-app taxtronik-worker taxtronik-n8n; do
    running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)"
    [[ "$running" != "true" ]] || die "Produktions-Restore verweigert: $container laeuft weiterhin."
  done
}

cmd_restore() {
  local restore_rc=0
  # Muss vor load_env/preflight/start_infra laufen: fehlerhafte oder
  # widerspruechliche Argumente duerfen keinerlei Betriebszustand veraendern.
  validate_restore_args "$@"
  load_env; preflight_common; assert_production_env
  unset TAXTRONIK_PRODUCTION_RESTORE_QUIESCED

  if [[ "$RESTORE_LIST_ONLY" == "1" ]]; then
    run_restore "$@" || { restore_rc=$?; return "$restore_rc"; }
    info "Restore-Liste gelesen (read-only)."
    return 0
  fi

  if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
    begin_database_restore_authorization "$RESTORE_RELEASE_VERSION"
    warn "PRODUKTIONS-RESTORE: App, Worker und n8n werden jetzt quiesziert und bleiben auch nach Erfolg/Fehler gestoppt."
    compose stop app worker n8n || die "Schreibdienste konnten vor dem Produktions-Restore nicht vollstaendig gestoppt werden."
    assert_restore_writers_stopped
    export TAXTRONIK_PRODUCTION_RESTORE_QUIESCED=1
  fi

  start_infra
  wait_postgres_healthy
  if restore_needs_s3 "$@"; then
    wait_seaweedfs_healthy
  fi
  sync_postgres_roles_from_env

  run_restore "$@" || {
    restore_rc=$?
    if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
      warn "Produktions-Restore fehlgeschlagen (Exit $restore_rc). App, Worker und n8n bleiben zur sicheren Diagnose gestoppt."
    fi
    return "$restore_rc"
  }
  if [[ "$RESTORE_PRODUCTION_TARGET" == "1" ]]; then
    authorize_database_restore_release "$RESTORE_RELEASE_VERSION"
    warn "Produktions-Restore fertig. App, Worker und n8n bleiben absichtlich gestoppt; passenden Release-Vertrag pruefen und erst danach starten."
  else
    info "Restore in explizites Ziel fertig."
  fi
}

# ---------------------------------------------------------------------------
# TCMS Stufe 2: Restore der verwalteten TCMS-Datenbank
#   ./taxtronik tcms restore --file <dump> --confirm-overwrite RESTORE_TCMS_DATABASE
# Reihenfolge: tcms-api stoppen -> tcms-db gesund -> Archiv lesbar -> aktuellen
# Stand sichern -> Rollen/Passwoerter aus .env -> Datenbank neu anlegen ->
# pg_restore (eine Transaktion, Abbruch beim ersten Fehler) -> tcms-migrate
# (Bootstrap, ausstehende Migrationen, Pruefung) -> tcms-api.
# ---------------------------------------------------------------------------
TCMS_RESTORE_CONFIRMATION="RESTORE_TCMS_DATABASE"
TCMS_RESTORE_FILE=""

# Vor jeder Seitenwirkung (auch vor load_env): Optionen, Bestaetigung, Datei,
# Pruefsumme. <dump>.sha256 ist Pflicht (Backup und Bucket fuehren sie mit):
# Ein Dump ohne passende Pruefsumme wird nie eingespielt.
validate_tcms_restore_args() {
  local file="" confirm="" seen_confirm=0
  while (( $# > 0 )); do
    case "$1" in
      --file)
        [[ $# -ge 2 && -n "$2" && "$2" != --* && -z "$file" ]] || die "--file erwartet genau einen Pfad."
        file="$2"; shift 2 ;;
      --confirm-overwrite)
        [[ $# -ge 2 && "$seen_confirm" == "0" ]] || die "--confirm-overwrite erwartet genau einen Wert."
        confirm="$2"; seen_confirm=1; shift 2 ;;
      *) die "Unbekannte Option: $1 (Nutzung: ./taxtronik tcms restore --file <dump> --confirm-overwrite $TCMS_RESTORE_CONFIRMATION)" ;;
    esac
  done
  [[ -n "$file" ]] || die "Nutzung: ./taxtronik tcms restore --file <dump> --confirm-overwrite $TCMS_RESTORE_CONFIRMATION"
  [[ "$confirm" == "$TCMS_RESTORE_CONFIRMATION" ]] || \
    die "Der TCMS-Restore ersetzt die TCMS-Datenbank. Bestaetigung exakt: --confirm-overwrite $TCMS_RESTORE_CONFIRMATION"
  [[ -f "$file" && -r "$file" && ! -L "$file" ]] || die "Dump ist keine lesbare regulaere Datei: $file"
  [[ -f "$file.sha256" && ! -L "$file.sha256" ]] || \
    die "Pruefsummen-Datei $file.sha256 fehlt; Restore verweigert (sie liegt neben jedem Backup und im Bucket)."
  ( cd "$(dirname "$file")" && sha256sum --check --quiet -- "$(basename "$file").sha256" ) >/dev/null 2>&1 || \
    die "SHA-256 des Dumps stimmt nicht mit $file.sha256 ueberein; Restore verweigert."
  [[ "$(cut -d' ' -f3- "$file.sha256")" == "$(basename "$file")" && "$(wc -l <"$file.sha256")" -eq 1 ]] || \
    die "Pruefsummen-Datei $file.sha256 muss genau den Dump nennen; Restore verweigert."
  TCMS_RESTORE_FILE="$file"
}

cmd_tcms_restore() {
  local file migrated
  validate_tcms_restore_args "$@"
  file="$TCMS_RESTORE_FILE"
  load_env
  [[ "$(tcms_deployment_mode)" == "managed" ]] || die "TCMS-Restore gilt fuer TCMS_DEPLOYMENT=managed."
  require_env TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD
  warn "TCMS-RESTORE: tcms-api wird gestoppt und die TCMS-Datenbank aus $file ersetzt."
  if docker inspect "$TCMS_API_CONTAINER" >/dev/null 2>&1; then
    docker stop --time 30 "$TCMS_API_CONTAINER" >/dev/null || die "tcms-api konnte nicht gestoppt werden."
  fi
  compose --profile tcms up -d --no-deps tcms-db || die "tcms-db konnte nicht gestartet werden."
  tcms_wait_db_healthy
  docker exec -i "$TCMS_DB_CONTAINER" pg_restore --list <"$file" >/dev/null || \
    die "Kein lesbares pg_dump-Archiv: $file; die TCMS-Datenbank bleibt unveraendert."
  migrated="$(docker exec "$TCMS_DB_CONTAINER" psql -X -U tcms -d tcms -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || true)"
  if [[ "$migrated" != "f" ]]; then
    run_backup_tcms "$(resolve_backup_host_dir)/tcms-pre-restore" || \
      die "Sicherung des bisherigen TCMS-Stands fehlgeschlagen; Restore verweigert."
    info "Bisheriger TCMS-Stand gesichert: $_TCMS_BACKUP_FILE"
  fi
  sync_tcms_roles_from_env || die "TCMS-Rollen konnten nicht angeglichen werden; Restore abgebrochen."
  printf 'DROP DATABASE IF EXISTS tcms WITH (FORCE);\nCREATE DATABASE tcms OWNER tcms;\n' | \
    docker exec -i "$TCMS_DB_CONTAINER" psql -X -q -U tcms -d postgres -v ON_ERROR_STOP=1 || \
    die "TCMS-Datenbank konnte nicht neu angelegt werden."
  docker exec -i "$TCMS_DB_CONTAINER" pg_restore -U tcms -d tcms --exit-on-error --single-transaction <"$file" || \
    die "pg_restore fehlgeschlagen; tcms-api bleibt gestoppt (vorheriger Stand: ${_TCMS_BACKUP_FILE:-keiner})."
  run_tcms_migrate
  tcms_restart_api || die "tcms-api nach dem Restore nicht healthy (Diagnose oben, ohne Werte)."
  info "TCMS-Restore fertig: Datenbank aus $file, Rollen aus .env, Migrationsschritt erfolgreich."
}

cmd_tcms_backup() {
  load_env
  [[ "$(tcms_deployment_mode)" == "managed" ]] || die "TCMS-Backup gilt fuer TCMS_DEPLOYMENT=managed."
  prepare_backup_host_dir
  ensure_s3_ready_for_backup
  backup_tcms_with_upload || die "TCMS-Backup fehlgeschlagen."
  info "TCMS-Backup fertig: ${_TCMS_BACKUP_FILE:-kein Dump (noch keine Daten)}"
}
