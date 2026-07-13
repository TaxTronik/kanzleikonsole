#!/bin/sh
set -eu

# S3-Credentials nie als fuer Host-Benutzer lesbare Bind-Mount-Datei ablegen.
# Der Container startet als root, rendert die Config in sein fluechtiges /run
# und uebergibt danach an das originale SeaweedFS-Entrypoint, das auf UID 1000
# droppt. 0400 + Owner 1000 stellt sicher, dass genau dieser Prozess lesen kann.
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY fehlt}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY fehlt}"

case "$S3_ACCESS_KEY$S3_SECRET_KEY" in
  *[!A-Za-z0-9._-]*)
    echo "FATAL: S3-Credentials enthalten fuer die Runtime-Konfiguration unzulaessige Zeichen." >&2
    exit 1
    ;;
esac

umask 077
mkdir -p /run/seaweedfs
sed \
  -e "s|__S3_ACCESS_KEY__|$S3_ACCESS_KEY|g" \
  -e "s|__S3_SECRET_KEY__|$S3_SECRET_KEY|g" \
  /etc/seaweedfs/s3.template.json > /run/seaweedfs/s3.json
chown 1000:1000 /run/seaweedfs/s3.json
chmod 0400 /run/seaweedfs/s3.json

exec /entrypoint.sh "$@"
