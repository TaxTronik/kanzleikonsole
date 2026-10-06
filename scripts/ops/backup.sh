#!/usr/bin/env bash
# =============================================================================
# Backups — Teil der Operator-CLI (./taxtronik).
#
# Host-Backupverzeichnis, DB-, n8n- und Object-Store-Backup, versiegeltes
# Full-Backup mit Cold-Volumes, Offsite-Upload, S3-Preflight und die
# backup-Kommandos.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

resolve_backup_host_dir() {
  local dir="${BACKUP_HOST_DIR:-../../backups}"
  if [[ "$dir" == /* ]]; then
    printf '%s\n' "$dir"
  else
    # Compose loest relative Bind-Mounts relativ zum Compose-File auf.
    (cd "$ROOT/infra/compose" && mkdir -p "$dir" && cd "$dir" && pwd -P)
  fi
}

prepare_backup_host_dir() {
  local dir
  dir="$(resolve_backup_host_dir)"
  info "Backup-Verzeichnis vorbereiten: $dir"
  mkdir -p "$dir" || die "Backup-Verzeichnis konnte nicht angelegt werden: $dir"
  chmod 0770 "$dir" 2>/dev/null || warn "chmod 0770 fuer $dir fehlgeschlagen."
  # Linux-Prod: node-User im Container hat UID/GID 1000. Wenn der Operator kein
  # chown darf, korrigiert backup-dir-init den Bind-Mount im Container.
  chown 1000:1000 "$dir" 2>/dev/null || true
}

run_backup_dir_init() {
  prepare_backup_host_dir
  info "Backup-Bind-Mount fuer App-Container berechtigen"
  docker rm -f taxtronik-backup-dir-init >/dev/null 2>&1 || true
  compose run --rm --no-deps backup-dir-init >/dev/null || \
    warn "backup-dir-init konnte den Bind-Mount nicht korrigieren. Pruefe BACKUP_HOST_DIR-Rechte, falls Browser-Backups EACCES liefern."
}

run_backup() {
  local backup_dir="${1:-}"
  require_cmd pnpm
  info "Backup starten"
  # Der Runner laeuft hier als Host-Prozess, nicht im App-Container. Daher ist
  # dessen Produktionspfad /app/backups ungeeignet. Normale CLI-/Update-Laeufe
  # verwenden den zum Compose-Bind-Mount gehoerenden Host-Pfad; Full-Backups
  # koennen weiterhin ein isoliertes Staging-Verzeichnis explizit uebergeben.
  if [[ -z "$backup_dir" ]]; then
    backup_dir="$(resolve_backup_host_dir)" || return $?
  fi
  mkdir -p "$backup_dir" || {
    warn "Backup-Verzeichnis konnte nicht angelegt werden: $backup_dir"
    return 1
  }
  backup_dir="$(cd "$backup_dir" && pwd -P)" || return $?
  [[ -w "$backup_dir" ]] || {
    warn "Backup-Verzeichnis ist fuer den Operator nicht beschreibbar: $backup_dir"
    return 1
  }
  # .prisma/client fuer den Host-tsx-Runner erzeugen. pnpm 11 + Monorepo führt
  # den @prisma/client-Postinstall nicht zuverlässig aus (Schema liegt in
  # packages/db) — sonst "Cannot find module '.prisma/client/default'".
  generate_prisma_client_for_host_tools || return $?
  # pg_dump-Escape-Hatch: falls der Host kein postgresql-client hat (Standard
  # bei Docker-Compose-Only-Setup), pg_dump aus dem laufenden Postgres-Container
  # nutzen. Client-Major passt dann garantiert zum Server (kein apt/Papierkram).
  # runner.ts liest PG_DUMP_PATH gezielt aus (siehe Kopfkommentar dort).
  if ! command -v pg_dump >/dev/null 2>&1; then
    export PG_DUMP_PATH="$ROOT/infra/scripts/pg_dump-via-container.sh"
    info "pg_dump fehlt auf dem Host -> nutze pg_dump aus dem Postgres-Container (PG_DUMP_PATH)."
  fi
  ensure_s3_ready_for_backup || return $?
  ( cd "$ROOT" && BACKUP_LOCAL_DIR="$backup_dir" pnpm --filter @taxtronik/web backup:run )
}

# P2-21: n8n-Datenbank sichern (Credentials/Ausführungshistorie). Die App-DB
# (taxtronik) deckt run_backup ab; die separate `n8n`-Postgres-DB fehlte im
# Backup. Dump landet als Custom-Format im lokalen Backup-Verzeichnis.
# Wiederherstellung manuell: pg_restore -h 127.0.0.1 -U n8n -d n8n <dump>
# (plus n8n_data-Volume; N8N_ENCRYPTION_KEY muss zum Dump passen).
run_backup_n8n() {
  local dest="${1:-${BACKUP_LOCAL_DIR:-$ROOT/backups}}"
  mkdir -p "$dest"
  # shellcheck disable=SC2155 # date ohne Fehlerpfad; run_backup_n8n hat keinen Test, daher unveraendert
  local out="$dest/n8n-db-$(date -u +'%Y%m%dT%H%M%SZ').dump"
  info "n8n-Datenbank sichern -> $out"
  # Secret nur im Prozess-Env (nicht in der Container-argv, vgl. P3-2).
  PGPASSWORD="${N8N_DB_PASSWORD:-n8n}" docker exec -i -e PGPASSWORD taxtronik-postgres \
    pg_dump -h 127.0.0.1 -U n8n -d n8n -Fc > "$out"
  info "n8n-Datenbank gesichert ($(du -h "$out" 2>/dev/null | cut -f1))."
}

object_store_backup_buckets() {
  # shellcheck disable=SC2086 # Wortzerlegung gewollt: Leerzeichen-getrennte Bucket-Liste (S3-Namen ohne Glob-Zeichen)
  printf '%s\n' ${BACKUP_OBJECT_BUCKETS:-${S3_BUCKET_GOBD:-gobd} ${S3_BUCKET_GWG:-gwg} ${S3_BUCKET_GENERAL:-general} ${S3_BUCKET_STAFF_PRIVATE:-staff-private}}
}

run_backup_files() {
  require_cmd docker
  local host_dir stamp dest bucket endpoint buckets_file
  prepare_backup_host_dir
  host_dir="$(resolve_backup_host_dir)"
  stamp="$(date -u +'%Y%m%d-%H%M%S')"
  dest="${1:-$host_dir/object-store/$stamp}"
  mkdir -p "$dest" || die "Object-Store-Backup-Ziel konnte nicht angelegt werden: $dest"
  chmod 0700 "$dest" 2>/dev/null || true

  endpoint="${BACKUP_OBJECT_ENDPOINT:-http://seaweedfs:8333}"
  buckets_file="$dest/buckets.txt"
  : > "$buckets_file"

  info "Kanzleidateien aus SeaweedFS exportieren: $dest"
  info "Hinweis: Dies ist eine Byte-Kopie der Buckets. Fuer Object-Lock-/Versioning-Metadaten zusaetzlich SeaweedFS-Replikation oder Volume-Snapshots nutzen."

  while IFS= read -r bucket; do
    [[ -z "$bucket" ]] && continue
    printf '%s\n' "$bucket" >> "$buckets_file"
    info "Bucket exportieren: $bucket"
    # P3-2: Secrets NICHT als `-e VAR=wert` (landet in der Container-argv, per
    # `docker inspect`/`ps` lesbar) — stattdessen im Prozess-Env setzen und per
    # `-e VAR` (ohne Wert) durchreichen. Docker liest den Wert dann aus dem Env.
    AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}" \
    docker run --rm \
      --network taxtronik \
      -e AWS_ACCESS_KEY_ID \
      -e AWS_SECRET_ACCESS_KEY \
      -e AWS_DEFAULT_REGION \
      -v "$dest:/backup" \
      "${TAXTRONIK_AWS_CLI_IMAGE:-$AWS_CLI_IMAGE_DEFAULT}" \
      --endpoint-url "$endpoint" s3 sync "s3://$bucket" "/backup/$bucket" --only-show-errors
  done < <(object_store_backup_buckets)

  {
    printf 'created_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'endpoint=%s\n' "$endpoint"
    printf 'buckets='
    paste -sd, "$buckets_file"
  } > "$dest/manifest.txt"
  info "Kanzleidateien-Export fertig: $dest"
}

container_named_volume() {
  local container="$1" destination="$2"
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" \
    "$container" 2>/dev/null || true
}

snapshot_named_volume() {
  local volume="$1" output_dir="$2" archive_name="$3"
  [[ -n "$volume" ]] || { warn "Docker-Volume fuer $archive_name nicht gefunden."; return 1; }
  mkdir -p "$output_dir"
  info "Cold-Snapshot Docker-Volume $volume -> $archive_name"
  docker run --rm \
    -v "$volume:/source:ro" \
    -v "$output_dir:/backup" \
    "${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}" \
    tar -C /source -czf "/backup/$archive_name" .
}

# Konsistenter Cold-Snapshot der nicht-relationalen, zustandsbehafteten Volumes.
# Der kurze Stop ist bewusst: Nur so bleiben SeaweedFS-Versionen/Object-Lock-
# Metadaten und Redis-AOF zusammen mit dem n8n-Volume auf einem definierten
# Zeitpunkt. Die DB-Dumps entstehen separat transaktionskonsistent via pg_dump.
run_cold_volume_snapshots() {
  local dest="$1" seaweed_volume redis_volume n8n_volume traefik_volume=""
  local snapshot_rc=0 restart_rc=0 method
  seaweed_volume="$(container_named_volume taxtronik-seaweedfs /data)"
  redis_volume="$(container_named_volume taxtronik-redis /data)"
  n8n_volume="$(container_named_volume taxtronik-n8n /home/node/.n8n)"
  method="$(deployment_method)" || return 1
  if [[ "$method" == "traefik" ]]; then
    traefik_volume="$(container_named_volume taxtronik-traefik /letsencrypt)"
  fi
  if [[ -z "$seaweed_volume" || -z "$redis_volume" || -z "$n8n_volume" ]]; then
    warn "Full-Backup kann benoetigte Volumes nicht aufloesen (SeaweedFS/Redis/n8n)."
    restart_backup_infra || true
    return 1
  fi
  if [[ "$method" == "traefik" && -z "$traefik_volume" ]]; then
    warn "Full-Backup kann das Traefik-ACME-Volume nicht aufloesen."
    restart_backup_infra || true
    return 1
  fi

  info "SeaweedFS/Redis fuer konsistenten Volume-Snapshot stoppen (Schreibdienste sind bereits quiesziert)"
  if ! compose --infra stop seaweedfs redis; then
    restart_backup_infra || true
    return 1
  fi
  if [[ "$method" == "traefik" ]]; then
    info "Traefik fuer konsistenten ACME-Snapshot stoppen"
    compose stop traefik || return 1
  fi

  snapshot_named_volume "$seaweed_volume" "$dest" seaweedfs-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$redis_volume" "$dest" redis-data.tar.gz || snapshot_rc=$?
  snapshot_named_volume "$n8n_volume" "$dest" n8n-data.tar.gz || snapshot_rc=$?
  if [[ "$method" == "traefik" ]]; then
    snapshot_named_volume "$traefik_volume" "$dest" traefik-acme.tar.gz || snapshot_rc=$?
  fi

  restart_backup_infra || restart_rc=$?
  if [[ $restart_rc -ne 0 ]]; then
    warn "Dienste konnten nach dem Cold-Snapshot nicht vollstaendig gestartet werden. Sofort manuell pruefen."
    return 1
  fi
  if [[ $snapshot_rc -ne 0 ]]; then
    warn "Mindestens ein Volume-Snapshot ist fehlgeschlagen; Dienste wurden wieder gestartet."
    return 1
  fi
}

restart_backup_infra() {
  info "SeaweedFS/Redis nach Cold-Snapshot wieder starten"
  compose --infra up -d --wait redis seaweedfs
}

restart_after_full_backup() {
  local rc=0
  info "Infra und Anwendungen nach Full-Backup wieder starten"
  restart_backup_infra || rc=$?
  if [[ $rc -eq 0 ]]; then start_apps || rc=$?; fi
  if [[ $rc -eq 0 ]]; then smoke_health || rc=$?; fi
  return "$rc"
}

_FULL_BACKUP_STAGING=""
_FULL_BACKUP_SERVICES_QUIESCED=0

full_backup_exit_cleanup() {
  local original_rc="${1:-1}"
  trap - EXIT INT TERM
  if [[ "$_FULL_BACKUP_SERVICES_QUIESCED" == "1" ]]; then
    restart_after_full_backup || warn "Notfall-Wiederanlauf nach abgebrochenem Full-Backup fehlgeschlagen."
  fi
  if [[ -n "$_FULL_BACKUP_STAGING" && -d "$_FULL_BACKUP_STAGING" ]]; then
    remove_full_backup_staging "$_FULL_BACKUP_STAGING" || warn "Plaintext-Staging konnte nicht entfernt werden: $_FULL_BACKUP_STAGING"
  fi
  exit "$original_rc"
}

cleanup_abandoned_full_backup_staging() {
  local full_root candidate
  full_root="$(resolve_backup_host_dir)/full"
  [[ -d "$full_root" ]] || return 0
  while IFS= read -r candidate; do
    [[ "$candidate" == "$full_root"/*/.staging ]] || die "Unsicheres Staging-Cleanup verweigert: $candidate"
    warn "Verwaistes Plaintext-Staging eines abgebrochenen Full-Backups entfernen: $candidate"
    rm -rf -- "$candidate"
  done < <(find "$full_root" -mindepth 2 -maxdepth 2 -type d -name .staging -print)
}

named_volume_size_kib() {
  local volume="$1"
  docker run --rm -v "$volume:/source:ro" \
    "${TAXTRONIK_ALPINE_BACKUP_IMAGE:-$ALPINE_BACKUP_IMAGE_DEFAULT}" \
    du -sk /source 2>/dev/null | awk 'NR==1 { print $1 }'
}

full_backup_capacity_preflight() {
  local host_dir="$1" seaweed_volume redis_volume n8n_volume seaweed_kib redis_kib n8n_kib db_kib available_kib required_kib
  seaweed_volume="$(container_named_volume taxtronik-seaweedfs /data)"
  redis_volume="$(container_named_volume taxtronik-redis /data)"
  n8n_volume="$(container_named_volume taxtronik-n8n /home/node/.n8n)"
  [[ -n "$seaweed_volume" && -n "$redis_volume" && -n "$n8n_volume" ]] || \
    die "Kapazitaets-Preflight kann Docker-Volumes nicht aufloesen."
  seaweed_kib="$(named_volume_size_kib "$seaweed_volume")"
  redis_kib="$(named_volume_size_kib "$redis_volume")"
  n8n_kib="$(named_volume_size_kib "$n8n_volume")"
  db_kib="$(docker exec taxtronik-postgres psql -U taxtronik -d taxtronik -tAc \
    "SELECT CEIL((pg_database_size('taxtronik') + pg_database_size('n8n')) / 1024.0)::bigint" | tr -d '[:space:]')"
  available_kib="$(df -Pk "$host_dir" | awk 'NR==2 { print $4 }')"
  [[ "$seaweed_kib" =~ ^[0-9]+$ && "$redis_kib" =~ ^[0-9]+$ && "$n8n_kib" =~ ^[0-9]+$ && \
     "$db_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]] || \
    die "Kapazitaets-Preflight konnte Groessen/freien Platz nicht belastbar ermitteln."
  # Peak: Byte-Export + Raw-Volume-Tars + parallel entstehendes age-Archiv.
  # Konservativ ohne Kompressionsgewinn, plus 1 GiB Arbeitsreserve.
  required_kib=$(( seaweed_kib * 5 + (redis_kib + n8n_kib + db_kib) * 3 + 1048576 ))
  (( available_kib >= required_kib )) || \
    die "Zu wenig freier Platz fuer Full-Backup: benoetigt konservativ ${required_kib} KiB, frei ${available_kib} KiB. BACKUP_HOST_DIR auf separates Backup-Dateisystem legen."
  info "Full-Backup-Kapazitaets-Preflight OK (frei ${available_kib} KiB, konservativer Bedarf ${required_kib} KiB)."
}

encrypt_full_backup_payload() {
  local payload="$1" dest="$2" recipient="${BACKUP_AGE_RECIPIENT:-}" root_files=(.env)
  require_cmd age
  [[ -n "$recipient" ]] || die "BACKUP_AGE_RECIPIENT fehlt. Full-Backup darf Konfiguration/Schluessel nur age-verschluesselt sichern."
  [[ -f "$STATE" ]] && root_files+=(.taxtronik.state)
  info "Gesamtes Full-Backup inklusive Recovery-Konfiguration age-verschluesseln"
  tar -cf - -C "$payload" . -C "$ROOT" "${root_files[@]}" | \
    age --recipient "$recipient" --output "$dest/full-backup.tar.age"
  chmod 0600 "$dest/full-backup.tar.age" 2>/dev/null || true
}

remove_full_backup_staging() {
  local staging="$1" expected_parent
  expected_parent="$(resolve_backup_host_dir)/full/"
  case "$staging" in
    "$expected_parent"*/.staging) rm -rf -- "$staging" ;;
    *) die "Unsicheres Staging-Cleanup verweigert: $staging" ;;
  esac
}

seal_full_backup() {
  local dest="$1" private_key="${BACKUP_MANIFEST_PRIVATE_KEY_FILE:-}" public_key="${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}"
  [[ -n "$private_key" && -f "$private_key" ]] || \
    die "BACKUP_MANIFEST_PRIVATE_KEY_FILE fehlt/ist unlesbar. Schluessel: node scripts/backup/manifest.mjs generate-key --out-dir <offline-pfad>"
  [[ -n "$public_key" && -f "$public_key" ]] || \
    die "BACKUP_MANIFEST_PUBLIC_KEY_FILE fehlt/ist unlesbar (Kopie getrennt/offline aufbewahren)."
  node "$ROOT/scripts/backup/manifest.mjs" create \
    --root "$dest" \
    --private-key "$private_key" \
    --version "$(image_tag)" \
    --commit "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  node "$ROOT/scripts/backup/manifest.mjs" verify \
    --root "$dest" \
    --public-key "$public_key"
}

offsite_backup_configured() {
  [[ -n "${BACKUP_OFFSITE_ENDPOINT:-}" && -n "${BACKUP_OFFSITE_BUCKET:-}" && \
     -n "${BACKUP_OFFSITE_ACCESS_KEY:-}" && -n "${BACKUP_OFFSITE_SECRET_KEY:-}" ]]
}

upload_full_backup_offsite() {
  local dest="$1" endpoint="${BACKUP_OFFSITE_ENDPOINT:-}" bucket="${BACKUP_OFFSITE_BUCKET:-}" prefix receipt min_days
  offsite_backup_configured || die "Offsite-Backup nicht vollstaendig konfiguriert (ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY)."
  [[ "$endpoint" == https://* ]] || die "BACKUP_OFFSITE_ENDPOINT muss HTTPS verwenden."
  [[ "$endpoint" != "${S3_ENDPOINT:-}" && "$endpoint" != *"seaweedfs"* ]] || \
    die "Offsite-Ziel darf nicht der lokale TaxTronik-Object-Store sein."
  min_days="${BACKUP_OFFSITE_MIN_RETENTION_DAYS:-90}"
  [[ "$min_days" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_OFFSITE_MIN_RETENTION_DAYS muss eine positive Ganzzahl sein."
  prefix="${BACKUP_OFFSITE_PREFIX:-taxtronik/full}/$(basename "$dest")"
  info "Signiertes Full-Backup in immutable Offsite-Bucket hochladen: s3://$bucket/$prefix"

  BACKUP_OFFSITE_ENDPOINT="$endpoint" \
  BACKUP_OFFSITE_BUCKET="$bucket" \
  BACKUP_OFFSITE_PREFIX="$prefix" \
  BACKUP_OFFSITE_MIN_RETENTION_DAYS="$min_days" \
  BACKUP_OFFSITE_ACCESS_KEY="$BACKUP_OFFSITE_ACCESS_KEY" \
  BACKUP_OFFSITE_SECRET_KEY="$BACKUP_OFFSITE_SECRET_KEY" \
  BACKUP_OFFSITE_REGION="${BACKUP_OFFSITE_REGION:-eu-central-1}" \
  docker run --rm \
    -e BACKUP_OFFSITE_ENDPOINT \
    -e BACKUP_OFFSITE_BUCKET \
    -e BACKUP_OFFSITE_PREFIX \
    -e BACKUP_OFFSITE_MIN_RETENTION_DAYS \
    -e BACKUP_OFFSITE_ACCESS_KEY \
    -e BACKUP_OFFSITE_SECRET_KEY \
    -e BACKUP_OFFSITE_REGION \
    -v "$dest:/backup:ro" \
    --entrypoint /bin/sh \
    "${TAXTRONIK_AWS_CLI_IMAGE:-$AWS_CLI_IMAGE_DEFAULT}" -ec '
      export AWS_ACCESS_KEY_ID="$BACKUP_OFFSITE_ACCESS_KEY"
      export AWS_SECRET_ACCESS_KEY="$BACKUP_OFFSITE_SECRET_KEY"
      export AWS_DEFAULT_REGION="$BACKUP_OFFSITE_REGION"
      aws_offsite() { aws --endpoint-url "$BACKUP_OFFSITE_ENDPOINT" "$@"; }
      MODE="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Mode --output text)"
      DAYS="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Days --output text)"
      YEARS="$(aws_offsite s3api get-object-lock-configuration --bucket "$BACKUP_OFFSITE_BUCKET" --query ObjectLockConfiguration.Rule.DefaultRetention.Years --output text)"
      VERSIONING="$(aws_offsite s3api get-bucket-versioning --bucket "$BACKUP_OFFSITE_BUCKET" --query Status --output text)"
      test "$VERSIONING" = Enabled
      test "$MODE" = COMPLIANCE
      EFFECTIVE_DAYS=0
      case "$DAYS" in None|"") : ;; *) EFFECTIVE_DAYS="$DAYS" ;; esac
      case "$YEARS" in None|"") : ;; *) EFFECTIVE_DAYS=$((YEARS * 365)) ;; esac
      test "$EFFECTIVE_DAYS" -ge "$BACKUP_OFFSITE_MIN_RETENTION_DAYS"

      for FILE in full-backup.tar.age manifest.json manifest.json.sig; do
        test -f "/backup/$FILE"
        aws_offsite s3 cp "/backup/$FILE" "s3://$BACKUP_OFFSITE_BUCKET/$BACKUP_OFFSITE_PREFIX/$FILE" --only-show-errors
        HEAD="$(aws_offsite s3api head-object --bucket "$BACKUP_OFFSITE_BUCKET" \
          --key "$BACKUP_OFFSITE_PREFIX/$FILE" \
          --query "[ContentLength,ObjectLockMode,ObjectLockRetainUntilDate,VersionId,ETag]" --output text)"
        set -- $HEAD
        test "$1" = "$(wc -c < "/backup/$FILE" | tr -d " ")"
        test "$2" = COMPLIANCE
        test "$3" != None && test -n "$3"
        test "$4" != None && test -n "$4"
        printf "%s\t%s\t%s\t%s\t%s\n" "$FILE" "$1" "$3" "$4" "$5"
      done
    ' > "${dest}.offsite-receipt.txt"
  chmod 0600 "${dest}.offsite-receipt.txt" 2>/dev/null || true
  receipt="${dest}.offsite-receipt.txt"
  [[ "$(wc -l < "$receipt")" -eq 3 ]] || die "Offsite-Receipt unvollstaendig."
  info "Offsite-Upload fuer alle 3 Artefakte mit VersionId, Groesse und COMPLIANCE-Retention verifiziert (Receipt: $receipt)."
}

wait_seaweedfs_healthy() {
  info "Warten bis SeaweedFS healthy ist"
  local deadline=$(( $(date +%s) + 120 )) s
  while :; do
    [[ $(date +%s) -ge $deadline ]] && die "SeaweedFS nach 120 s nicht healthy."
    s="$(docker inspect --format '{{.State.Health.Status}}' taxtronik-seaweedfs 2>/dev/null || true)"
    [[ "$s" == "healthy" ]] && { info "SeaweedFS healthy."; return 0; }
    sleep 2
  done
}

s3_preflight() {
  require_env S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY
  node --input-type=module <<'NODE'
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

try {
  const result = await client.send(new ListBucketsCommand({}));
  const backupBucket = process.env.S3_BUCKET_BACKUPS || 'backups';
  const buckets = result.Buckets?.map((bucket) => bucket.Name).filter(Boolean) ?? [];
  if (!buckets.includes(backupBucket)) {
    throw new Error(`Backup-Bucket '${backupBucket}' fehlt`);
  }
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error));
  console.error(`[s3-preflight] ${e.name}: ${e.message}`);
  process.exit(1);
}
NODE
}

reload_seaweedfs_credentials_from_env() {
  info "SeaweedFS-S3-Konfiguration aus .env neu laden"
  render_s3_config
  compose --infra up -d --force-recreate seaweedfs
  wait_seaweedfs_healthy
  docker rm -f taxtronik-seaweedfs-init >/dev/null 2>&1 || true
  compose --infra up -d seaweedfs-init
  local code
  code="$(docker wait taxtronik-seaweedfs-init 2>/dev/null || echo 1)"
  if [[ "$code" != "0" ]]; then
    compose --infra logs seaweedfs-init --tail 80 || true
    die "SeaweedFS-Bucket-Init fehlgeschlagen (Exit $code)."
  fi
}

ensure_s3_ready_for_backup() {
  info "S3-Preflight (SeaweedFS Credentials/Buckets)"
  if s3_preflight; then
    return 0
  fi
  warn "S3-Preflight fehlgeschlagen. Vermutlich laufen SeaweedFS-Credentials noch mit alter s3.json. Lade Object-Store aus .env neu."
  reload_seaweedfs_credentials_from_env
  s3_preflight || die "S3-Preflight auch nach SeaweedFS-Neuladen fehlgeschlagen. S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY pruefen."
}

cmd_backup() {
  load_env; preflight_common; assert_production_env
  start_infra
  wait_postgres_healthy
  wait_seaweedfs_healthy
  sync_postgres_roles_from_env
  run_backup
  info "Backup fertig."
}

cmd_backup_files() {
  load_env; preflight_common; assert_production_env
  start_infra
  wait_seaweedfs_healthy
  ensure_s3_ready_for_backup
  run_backup_files
  info "Kanzleidateien-Backup fertig."
}

cmd_backup_full() {
  load_env; preflight_common; assert_production_env
  require_cmd age
  require_cmd flock
  start_infra
  wait_postgres_healthy
  wait_seaweedfs_healthy
  sync_postgres_roles_from_env
  compose up -d n8n

  local host_dir dest staging
  host_dir="$(resolve_backup_host_dir)"
  prepare_backup_host_dir
  exec 9>"$host_dir/.full-backup.lock"
  flock -n 9 || die "Ein anderes Full-Backup laeuft bereits."
  cleanup_abandoned_full_backup_staging
  full_backup_capacity_preflight "$host_dir"
  dest="$host_dir/full/$(date -u +'%Y%m%dT%H%M%SZ')"
  staging="$dest/.staging"
  _FULL_BACKUP_STAGING="$staging"
  mkdir -p "$staging/database" "$staging/object-store-byte-export" "$staging/volumes"
  chmod 0700 "$dest" 2>/dev/null || true
  trap 'full_backup_exit_cleanup $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Ein Full-Backup ist ein zusammengehoeriger Wiederanlaufpunkt. App, Worker
  # und n8n werden VOR DB-Dumps und Object-Export gestoppt, damit keine DB-
  # Referenz zwischen Dump und SeaweedFS-Snapshot neu entsteht/verschwindet.
  info "Schreibdienste fuer konsistenten Full-Backup-Wiederanlaufpunkt quieszieren"
  _FULL_BACKUP_SERVICES_QUIESCED=1
  compose stop app worker n8n || die "Schreibdienste konnten nicht vollstaendig gestoppt werden."
  if ! run_backup "$staging/database"; then
    die "TaxTronik-DB-Dump im Full-Backup fehlgeschlagen."
  fi
  if ! run_backup_n8n "$staging/database"; then
    die "n8n-DB-Dump im Full-Backup fehlgeschlagen."
  fi
  if ! run_backup_files "$staging/object-store-byte-export"; then
    die "Object-Store-Byte-Export im Full-Backup fehlgeschlagen."
  fi
  run_cold_volume_snapshots "$staging/volumes" || die "Cold-Volume-Snapshot oder Wiederanlauf fehlgeschlagen."
  encrypt_full_backup_payload "$staging" "$dest"
  remove_full_backup_staging "$staging"
  _FULL_BACKUP_STAGING=""
  seal_full_backup "$dest"
  restart_after_full_backup || die "Full-Backup ist versiegelt, aber der Wiederanlauf der Dienste ist fehlgeschlagen."
  _FULL_BACKUP_SERVICES_QUIESCED=0
  trap - EXIT INT TERM
  flock -u 9
  exec 9>&-

  if offsite_backup_configured; then
    upload_full_backup_offsite "$dest"
  elif [[ "${BACKUP_OFFSITE_REQUIRED:-false}" == "true" ]]; then
    die "Lokales Full-Backup erstellt, aber BACKUP_OFFSITE_REQUIRED=true und kein vollstaendiges Offsite-Ziel konfiguriert: $dest"
  else
    warn "Full-Backup ist lokal versiegelt, aber noch nicht offsite: $dest"
  fi
  info "Vollbackup fertig: DB + n8n-DB + Byte-Export + Cold-Volumes + Recovery-Konfiguration gemeinsam age-verschluesselt; signiertes SHA-256-Manifest ($dest)."
}

cmd_backup_verify() {
  local dest="${1:-}" public_key="${2:-${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}}"
  [[ -n "$dest" && -d "$dest" ]] || die "Nutzung: ./taxtronik backup-verify <full-backup-verzeichnis>"
  require_cmd node
  [[ -n "$public_key" ]] || public_key="$(get_env BACKUP_MANIFEST_PUBLIC_KEY_FILE)"
  [[ -n "$public_key" && -f "$public_key" ]] || \
    die "Public Key fehlt. Als 2. Argument oder BACKUP_MANIFEST_PUBLIC_KEY_FILE uebergeben."
  node "$ROOT/scripts/backup/manifest.mjs" verify \
    --root "$dest" \
    --public-key "$public_key"
}

cmd_backup_decrypt() {
  local dest="${1:-}" target="${2:-}" identity="${3:-${BACKUP_AGE_IDENTITY_FILE:-}}" public_key="${4:-${BACKUP_MANIFEST_PUBLIC_KEY_FILE:-}}"
  [[ -n "$dest" && -d "$dest" && -f "$dest/full-backup.tar.age" ]] || \
    die "Nutzung: ./taxtronik backup-decrypt <full-backup-verzeichnis> <leeres-zielverzeichnis>"
  [[ -n "$target" ]] || die "Zielverzeichnis fuer entschluesselte Recovery-Artefakte fehlt."
  require_cmd age
  require_cmd tar
  [[ -n "$identity" ]] || identity="$(get_env BACKUP_AGE_IDENTITY_FILE)"
  [[ -n "$public_key" ]] || public_key="$(get_env BACKUP_MANIFEST_PUBLIC_KEY_FILE)"
  [[ -n "$identity" && -f "$identity" ]] || \
    die "age-Identity fehlt. Als 3. Argument oder BACKUP_AGE_IDENTITY_FILE am isolierten Restore-System uebergeben."
  if [[ -e "$target" && -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "Restore-Ziel muss leer sein: $target"
  fi
  mkdir -p "$target"
  chmod 0700 "$target" 2>/dev/null || true
  cmd_backup_verify "$dest" "$public_key"
  info "Full-Backup in isoliertes Ziel entschluesseln: $target"
  age --decrypt --identity "$identity" "$dest/full-backup.tar.age" | \
    tar --extract --file - --directory "$target" --no-same-owner --no-same-permissions
  [[ -d "$target/database" && -f "$target/volumes/seaweedfs-data.tar.gz" && \
     -f "$target/volumes/redis-data.tar.gz" && -f "$target/volumes/n8n-data.tar.gz" && \
     -f "$target/.env" ]] || die "Entschluesseltes Full-Backup ist unvollstaendig."
  tar -tzf "$target/volumes/seaweedfs-data.tar.gz" >/dev/null
  tar -tzf "$target/volumes/redis-data.tar.gz" >/dev/null
  tar -tzf "$target/volumes/n8n-data.tar.gz" >/dev/null
  if [[ -f "$target/volumes/traefik-acme.tar.gz" ]]; then
    tar -tzf "$target/volumes/traefik-acme.tar.gz" >/dev/null
  fi
  info "Entschluesselung + Archiv-Strukturpruefung erfolgreich. Restore ausschliesslich nach DR-Runbook auf isoliertem Ziel fortsetzen."
}

cmd_backup_offsite() {
  local dest="${1:-}"
  [[ -n "$dest" && -d "$dest" ]] || die "Nutzung: ./taxtronik backup-offsite <full-backup-verzeichnis>"
  load_env
  cmd_backup_verify "$dest"
  upload_full_backup_offsite "$dest"
}
