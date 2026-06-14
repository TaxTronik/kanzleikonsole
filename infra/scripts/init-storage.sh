#!/bin/sh
# =============================================================================
# taxtronik — Object-Store-Bucket-Initialisierung (SeaweedFS / S3-API)
#
# Legt folgende Buckets an (S3-Standard, kompatibel zu jeder S3-Engine):
#   - gobd            Object-Lock COMPLIANCE, 10 Jahre — GoBD/§ 147 AO
#   - gwg             Object-Lock COMPLIANCE, 5 Jahre  — § 8 Abs. 4 GwG
#                     B-1: GwG-Daten dürfen NICHT 10 Jahre aufbewahrt werden.
#                     Eigener Bucket statt gobd, kürzere Default-Retention.
#   - general         transiente Anhänge, KB-Bilder
#   - staff-private   privater Mitarbeiter-Storage (mit Versioning)
#   - backups         DB-Dumps + Audit-Archive (90-Tage-Lifecycle)
#
# Object-Lock muss bei der Bucket-Anlage aktiviert werden — nachträglich
# nicht möglich. Das Skript ist idempotent; bestehende Buckets bleiben.
#
# Bewusst KEIN CORS und KEIN Browser-Ziel-Bucket (Security-Audit 2026-06,
# Befund 1): Die frühere Presigned-Upload-Architektur (Browser-PUT in einen
# `quarantine`-Bucket, asynchroner Scan) ist aufgegeben. Uploads laufen
# app-proxied mit synchronem ClamAV-Scan VOR dem DB-Insert
# (packages/storage/src/service.ts) — der Object-Store hängt nur am internen
# Docker-Netz und darf für Browser weder erreichbar noch beschreibbar sein.
# =============================================================================

set -e

ENDPOINT="${S3_ENDPOINT:-http://seaweedfs:8333}"
AWS="aws --endpoint-url $ENDPOINT"

# Bis SeaweedFS-S3-Gateway antwortet
echo "[init-storage] Warte auf S3-Endpoint $ENDPOINT…"
for i in $(seq 1 60); do
  if $AWS s3api list-buckets >/dev/null 2>&1; then
    echo "[init-storage] Endpoint erreichbar."
    break
  fi
  sleep 2
done

bucket_exists() {
  $AWS s3api head-bucket --bucket "$1" >/dev/null 2>&1
}

ensure_bucket_with_lock() {
  local name="$1"
  local years="$2"
  if bucket_exists "$name"; then
    echo "[init-storage] Bucket '$name' existiert bereits."
    return
  fi
  echo "[init-storage] Erstelle Bucket '$name' mit Object-Lock (${years} Jahre)…"
  $AWS s3api create-bucket --bucket "$name" --object-lock-enabled-for-bucket
  # GoBD/GwG-Retention ist compliance-kritisch — KEIN || true.
  # Wenn Object-Lock nicht gesetzt werden kann, ist das ein GoBD-Bruch
  # und der gesamte Storage-Setup muss fehlschlagen.
  $AWS s3api put-object-lock-configuration --bucket "$name" \
    --object-lock-configuration "{\"ObjectLockEnabled\":\"Enabled\",\"Rule\":{\"DefaultRetention\":{\"Mode\":\"COMPLIANCE\",\"Years\":${years}}}}"
}

ensure_bucket() {
  local name="$1"
  if bucket_exists "$name"; then
    echo "[init-storage] Bucket '$name' existiert bereits."
    return
  fi
  echo "[init-storage] Erstelle Bucket '$name'…"
  $AWS s3api create-bucket --bucket "$name"
}

ensure_bucket_with_lock gobd 10
ensure_bucket_with_lock gwg 5

for b in general staff-private backups; do
  ensure_bucket "$b"
done

# Versionierung für staff-private (versehentliche Überschreibungen wiederherstellbar)
# WARNUNG, nicht fatal — SeaweedFS unterstützt evtl. nicht alle Versioning-Features.
$AWS s3api put-bucket-versioning --bucket staff-private \
  --versioning-configuration Status=Enabled \
  || echo "[init-storage] WARNUNG: Versioning für staff-private fehlgeschlagen (SeaweedFS-Limit)"

# Lifecycle-Rules für backups (90-Tage-Expiry)
$AWS s3api put-bucket-lifecycle-configuration --bucket backups \
  --lifecycle-configuration '{
    "Rules":[{
      "ID":"expire-backups-90d",
      "Status":"Enabled",
      "Filter":{"Prefix":""},
      "Expiration":{"Days":90}
    }]
  }' \
  || echo "[init-storage] WARNUNG: Lifecycle-Rule für backups fehlgeschlagen (SeaweedFS-Limit)"

echo "[init-storage] Fertig."
