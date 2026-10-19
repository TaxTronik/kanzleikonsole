#!/usr/bin/env bash
# =============================================================================
# Release-Gate fuer die Tax-CMS-Images (TCMS Stufe 2).
#
#   bash scripts/release/verify-tcms-pins.sh --prefix <registry>/<owner> \
#     [--commit <sha>] [--repo <pfad>]
#
# Liest infra/compose/tcms-release.env aus dem Release-Commit (Standard: HEAD
# des Repositorys dieses Skripts), genau wie die Operator-CLI beim Kunden, und
# prueft fuer tcms-api und tcms-migrate: Das Image existiert unter genau diesem
# Digest in der Release-Registry (docker pull per Digest prueft den Inhalt)
# und traegt das Label org.opencontainers.image.version der TCMS-Version.
# Ohne Pins (kein TCMS im Release) endet das Gate erfolgreich. Die Images baut
# und veroeffentlicht das TCMS-Repository in dieselbe Registry
# (docs/operations/tcms-betrieb.md, Abschnitt 3).
# =============================================================================
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../ops-lib.sh
source "$SCRIPT_ROOT/scripts/ops-lib.sh"

prefix=""
commit=""
repo="$SCRIPT_ROOT"
while (( $# > 0 )); do
  case "$1" in
    --prefix|--commit|--repo)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 erwartet einen Wert."
      case "$1" in
        --prefix) prefix="$2" ;;
        --commit) commit="$2" ;;
        --repo) repo="$2" ;;
      esac
      shift 2
      ;;
    *) die "Unbekannte Option: $1" ;;
  esac
done
[[ "$prefix" =~ ^[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9._/-]*$ ]] || \
  die "--prefix muss <registry>/<projekt> sein."
ROOT="$repo"
[[ -n "$commit" ]] || commit="$(git -C "$ROOT" rev-parse HEAD)"

pins="$(tcms_read_release_pins "$commit")" || die "TCMS-Pins im Release-Commit sind ungueltig."
tcms_split_pins "$pins"
version="$_TCMS_PIN_VERSION"; api="$_TCMS_PIN_API"; migrate="$_TCMS_PIN_MIGRATE"
if [[ -z "$version" ]]; then
  echo "Kein TCMS-Release verankert (infra/compose/tcms-release.env leer); nichts zu pruefen."
  exit 0
fi

for role in api migrate; do
  if [[ "$role" == "api" ]]; then digest="$api"; else digest="$migrate"; fi
  ref="${prefix%/}/tcms-$role:${version}@${digest}"
  docker pull "$ref" >/dev/null || die "tcms-$role ist unter $ref nicht in der Release-Registry verfuegbar."
  label="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ref")" || \
    die "Labels von $ref nicht lesbar."
  [[ "$label" == "$version" ]] || \
    die "tcms-$role traegt version=$label statt der verankerten TCMS-Version $version."
done
echo "OK: tcms-api und tcms-migrate $version liegen per Digest in $prefix und tragen das Versionslabel."
