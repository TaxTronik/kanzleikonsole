#!/usr/bin/env bash
# =============================================================================
# apt-get fuer CI-Schritte, nur gegen die benoetigten Paketquellen.
#
# Das Runner-Image bringt fremde Quellen mit (git-core-PPA, Microsoft,
# packagecloud). Faellt eine davon aus, scheitert `apt-get update` (CI-Lauf
# 3895: PPA mit 503), und apt duerfte Pakete auch aus ihnen ziehen. Hier
# gelten nur das Ubuntu-Archiv und PGDG (apt.postgresql.org); eine Quelle mit
# anderem Host wird uebergangen und gemeldet. `update` versucht es dreimal.
#
# Aufruf:  bash scripts/ci/apt.sh update
#          bash scripts/ci/apt.sh install <apt-get-install-Argumente…>
# Als Nicht-root ueber sudo. Testhaken: CI_APT_ETC (Standard /etc/apt),
# CI_APT_GET (Standard apt-get), CI_APT_PAUSE (Sekunden, Standard 10).
# =============================================================================
set -euo pipefail

ETC=${CI_APT_ETC:-/etc/apt}
APT_GET=${CI_APT_GET:-apt-get}
PAUSE=${CI_APT_PAUSE:-10}
ERLAUBT='^(([a-z0-9-]+\.)?archive\.ubuntu\.com|security\.ubuntu\.com|ports\.ubuntu\.com|apt\.postgresql\.org)$'

melde() { printf 'ci-apt: %s\n' "$*" >&2; }

ZIEL=''
trap '[[ -z $ZIEL ]] || rm -rf -- "$ZIEL"' EXIT

# Host einer URI (ohne Schema, Benutzer, Port, Pfad), klein geschrieben.
host_von() {
  local uri=${1#*://}
  uri=${uri%%/*}
  uri=${uri##*@}
  uri=${uri%%:*}
  printf '%s' "${uri,,}"
}

erlaubt() { [[ $1 == http://* || $1 == https://* ]] && [[ $(host_von "$1") =~ $ERLAUBT ]]; }

# Einzeilenformat: nur deb/deb-src-Zeilen mit erlaubtem Host bleiben.
filtere_liste() {
  local datei=$1 name zeile uri
  name=$(basename "$datei")
  while IFS= read -r zeile || [[ -n $zeile ]]; do
    [[ $zeile =~ ^[[:space:]]*deb(-src)?[[:space:]] ]] || continue
    uri=$(sed -E 's/^[[:space:]]*deb(-src)?[[:space:]]+(\[[^]]*\][[:space:]]+)?([^[:space:]]+).*$/\3/' <<<"$zeile")
    if erlaubt "$uri"; then
      printf '%s\n' "$zeile"
    else
      melde "Quelle uebergangen: $(host_von "$uri") ($name)"
    fi
  done <"$datei"
}

# deb822 (*.sources): die Datei nur, wenn jede URI erlaubt ist.
deb822_erlaubt() {
  local datei=$1 name uri gesehen=0
  name=$(basename "$datei")
  while IFS= read -r uri; do
    [[ -n $uri ]] || continue
    if ! erlaubt "$uri"; then
      melde "Quelle uebergangen: $(host_von "$uri") ($name)"
      return 1
    fi
    gesehen=1
  done < <(sed -nE 's/^URIs:[[:space:]]*//p' "$datei" | tr -s '[:blank:]' '\n')
  ((gesehen == 1))
}

# Gefilterte Kopie der Quellen; ZIEL bleibt fuer den apt-get-Aufruf bestehen.
quellen_bauen() {
  local datei eintraege gefiltert
  ZIEL=$(mktemp -d)
  mkdir "$ZIEL/teile"
  : >"$ZIEL/sources.list"
  [[ ! -f $ETC/sources.list ]] || filtere_liste "$ETC/sources.list" >"$ZIEL/sources.list"
  for datei in "$ETC"/sources.list.d/*.list; do
    [[ -f $datei ]] || continue
    gefiltert=$(filtere_liste "$datei")
    [[ -z $gefiltert ]] || printf '%s\n' "$gefiltert" >"$ZIEL/teile/$(basename "$datei")"
  done
  for datei in "$ETC"/sources.list.d/*.sources; do
    [[ -f $datei ]] || continue
    if deb822_erlaubt "$datei"; then cp -- "$datei" "$ZIEL/teile/"; fi
  done
  eintraege=$(cat "$ZIEL/sources.list" "$ZIEL"/teile/*.list 2>/dev/null | grep -c . || true)
  if ((eintraege == 0)) && ! compgen -G "$ZIEL/teile/*.sources" >/dev/null; then
    melde 'keine erlaubte Paketquelle gefunden'
    exit 1
  fi
  chmod -R a+rX "$ZIEL"
}

als_root() {
  if [[ $(id -u) -eq 0 ]] || ! command -v sudo >/dev/null 2>&1; then
    "$@"
  else
    sudo "$@"
  fi
}

apt_mit_quellen() {
  # List-Cleanup=0: Indizes der uebergangenen Quellen bleiben unangetastet.
  als_root "$APT_GET" -o "Dir::Etc::sourcelist=$ZIEL/sources.list" \
    -o "Dir::Etc::sourceparts=$ZIEL/teile" -o APT::Get::List-Cleanup=0 "$@"
}

case ${1:-} in
  update)
    quellen_bauen
    for versuch in 1 2 3; do
      if apt_mit_quellen update; then
        exit 0
      fi
      if ((versuch < 3)); then
        melde "apt-get update fehlgeschlagen (Versuch $versuch/3), neuer Versuch in $((PAUSE * versuch)) s"
        sleep $((PAUSE * versuch))
      fi
    done
    melde 'apt-get update dreimal fehlgeschlagen'
    exit 1
    ;;
  install)
    shift
    quellen_bauen
    apt_mit_quellen install "$@"
    ;;
  *)
    melde 'Aufruf: apt.sh update | apt.sh install <Argumente…>'
    exit 64
    ;;
esac
