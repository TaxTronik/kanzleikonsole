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
#   - quarantine      Virus-Treffer (30-Tage-Lifecycle)
#   - backups         DB-Dumps + Audit-Archive (90-Tage-Lifecycle)
#
# Object-Lock muss bei der Bucket-Anlage aktiviert werden — nachträglich
# nicht möglich. Das Skript ist idempotent; bestehende Buckets bleiben.
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
  $AWS s3api put-object-lock-configuration --bucket "$name" \
    --object-lock-configuration "{\"ObjectLockEnabled\":\"Enabled\",\"Rule\":{\"DefaultRetention\":{\"Mode\":\"COMPLIANCE\",\"Years\":${years}}}}" || true
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

for b in general staff-private quarantine backups; do
  ensure_bucket "$b"
done

# Versionierung für staff-private (versehentliche Überschreibungen wiederherstellbar)
$AWS s3api put-bucket-versioning --bucket staff-private \
  --versioning-configuration Status=Enabled || true

# Lifecycle-Rules
$AWS s3api put-bucket-lifecycle-configuration --bucket quarantine \
  --lifecycle-configuration '{
    "Rules":[{
      "ID":"expire-quarantine-30d",
      "Status":"Enabled",
      "Filter":{"Prefix":""},
      "Expiration":{"Days":30}
    }]
  }' || true

$AWS s3api put-bucket-lifecycle-configuration --bucket backups \
  --lifecycle-configuration '{
    "Rules":[{
      "ID":"expire-backups-90d",
      "Status":"Enabled",
      "Filter":{"Prefix":""},
      "Expiration":{"Days":90}
    }]
  }' || true

# =============================================================================
# CORS — der Browser PUTtet Presigned-Uploads direkt an den Object-Store.
# Ohne CORS-Header wirft fetch() ein generisches "Failed to fetch", obwohl
# der Server die Anfrage tatsächlich erreicht hätte.
#
# Wir konfigurieren das nur für den `quarantine`-Bucket, weil das der einzige
# Browser-Ziel-Bucket ist (Upload landet zuerst dort, Worker verschiebt nach
# der Virus-Prüfung in den Ziel-Bucket).
#
# Origin: aus APP_PUBLIC_ORIGIN bzw. NEXTAUTH_URL abgeleitet. Mehrere Origins
# kannst Du komma-getrennt in APP_PUBLIC_ORIGIN setzen
# (z. B. `https://staff.kanzlei.de,https://portal.kanzlei.de`).
# =============================================================================

RAW_ORIGINS="${APP_PUBLIC_ORIGIN:-${NEXTAUTH_URL:-http://localhost:3000}}"
# Komma → JSON-Array-Elemente
ORIGINS_JSON=$(echo "$RAW_ORIGINS" | awk -F',' '{
  for (i = 1; i <= NF; i++) {
    gsub(/^ +| +$/, "", $i)
    printf "%s\"%s\"", (i > 1 ? "," : ""), $i
  }
}')

echo "[init-storage] Setze CORS auf 'quarantine' für Origin(s): $RAW_ORIGINS"
$AWS s3api put-bucket-cors --bucket quarantine --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [${ORIGINS_JSON}],
    \"AllowedMethods\": [\"PUT\", \"GET\", \"HEAD\"],
    \"AllowedHeaders\": [\"*\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}" || echo "[init-storage] WARNUNG: CORS-Setup fehlgeschlagen (SeaweedFS-Version ohne PutBucketCors?). Browser-Upload schlägt sonst mit 'Failed to fetch' fehl."

echo "[init-storage] Fertig."
