#!/usr/bin/env bash
# =============================================================================
# scripts/ci/apt.sh: apt-get in CI nur gegen Ubuntu-Archiv und PGDG, `update`
# mit drei Versuchen (CI-Lauf 3895: git-core-PPA des Runner-Images mit 503).
# apt-get ist eine Attrappe, die Argumente und die uebergebenen Quellen
# protokolliert. Aufruf: bash scripts/tests/ci-apt.test.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKRIPT="$ROOT/scripts/ci/apt.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT
TESTS=0

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}
pass() {
  TESTS=$((TESTS + 1))
  printf 'ok %s - %s\n' "$TESTS" "$*"
}

# Quellen wie im Runner-Image act-22.04 plus Faelle, die nicht durchrutschen duerfen.
etc_anlegen() {
  local etc="$1"
  mkdir -p "$etc/sources.list.d"
  cat >"$etc/sources.list" <<'EOF'
# Kommentar
deb http://archive.ubuntu.com/ubuntu/ jammy main restricted
deb-src http://archive.ubuntu.com/ubuntu/ jammy main
deb http://security.ubuntu.com/ubuntu/ jammy-security main
deb http://archive.ubuntu.com.evil.example/ubuntu/ jammy main
deb http://evilarchive.ubuntu.com/ubuntu/ jammy main
deb ftp://archive.ubuntu.com/ubuntu/ jammy universe
EOF
  printf 'deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/ jammy main\n' \
    >"$etc/sources.list.d/git-core-ubuntu-ppa-jammy.list"
  printf 'deb [arch=amd64,armhf,arm64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/22.04/prod jammy main\n' \
    >"$etc/sources.list.d/microsoft-prod.list"
  printf 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt jammy-pgdg main\n' \
    >"$etc/sources.list.d/pgdg.list"
  cat >"$etc/sources.list.d/ubuntu.sources" <<'EOF'
Types: deb
URIs: http://de.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates
Components: main

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main
EOF
  cat >"$etc/sources.list.d/gemischt.sources" <<'EOF'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/ https://packagecloud.io/github/git-lfs/ubuntu/
Suites: jammy
Components: main
EOF
}

# Attrappe: protokolliert Aufruf und Inhalt der uebergebenen Quellen;
# scheitert, solange FEHLER_BIS groesser als die Zahl der Aufrufe ist.
apt_attrappe() {
  cat >"$TMP_DIR/apt-get" <<EOF
#!/usr/bin/env bash
n=\$(cat "$TMP_DIR/aufrufe" 2>/dev/null || echo 0); n=\$((n + 1)); echo "\$n" >"$TMP_DIR/aufrufe"
{
  printf 'AUFRUF %s\n' "\$*"
  for a in "\$@"; do
    case \$a in
      Dir::Etc::sourcelist=*) cat "\${a#*=}" ;;
      Dir::Etc::sourceparts=*) for d in "\${a#*=}"/*; do [ -f "\$d" ] && { echo "TEIL \$(basename "\$d")"; cat "\$d"; }; done ;;
    esac
  done
} >>"$TMP_DIR/protokoll"
[ "\$n" -gt "\${FEHLER_BIS:-0}" ]
EOF
  chmod +x "$TMP_DIR/apt-get"
}

lauf() {
  rm -f "$TMP_DIR/protokoll" "$TMP_DIR/aufrufe"
  CI_APT_ETC="$TMP_DIR/etc" CI_APT_GET="$TMP_DIR/apt-get" CI_APT_PAUSE=0 bash "$SKRIPT" "$@" \
    >"$TMP_DIR/out" 2>&1
}

etc_anlegen "$TMP_DIR/etc"
apt_attrappe

# Regel: nur Ubuntu-Archiv und PGDG; jede andere Quelle wird uebergangen und gemeldet.
lauf update || fail "update failed: $(cat "$TMP_DIR/out")"
protokoll=$(cat "$TMP_DIR/protokoll")
for erwartet in 'deb http://archive.ubuntu.com/ubuntu/ jammy main restricted' \
  'deb-src http://archive.ubuntu.com/ubuntu/ jammy main' \
  'deb http://security.ubuntu.com/ubuntu/ jammy-security main' \
  'http://apt.postgresql.org/pub/repos/apt jammy-pgdg main' \
  'URIs: http://de.archive.ubuntu.com/ubuntu/' 'TEIL ubuntu.sources'; do
  [[ $protokoll == *"$erwartet"* ]] || fail "allowed source missing: $erwartet"
done
for verboten in launchpadcontent microsoft evil.example evilarchive packagecloud ftp:// 'TEIL gemischt.sources' '# Kommentar'; do
  [[ $protokoll != *"$verboten"* ]] || fail "foreign source passed: $verboten"
done
for host in ppa.launchpadcontent.net packages.microsoft.com archive.ubuntu.com.evil.example evilarchive.ubuntu.com packagecloud.io; do
  grep -q "Quelle uebergangen: $host" "$TMP_DIR/out" || fail "skipped source not reported: $host"
done
grep -q '^AUFRUF .*APT::Get::List-Cleanup=0 update$' "$TMP_DIR/protokoll" || fail "update without List-Cleanup=0"
pass "only the Ubuntu archive and PGDG reach apt-get; foreign sources are reported"

# Regel: update versucht es dreimal und meldet danach den Fehler.
FEHLER_BIS=2 lauf update || fail "update did not recover after two failures"
[[ $(cat "$TMP_DIR/aufrufe") == 3 ]] || fail "expected three update attempts"
if FEHLER_BIS=3 lauf update; then fail "update succeeded although every attempt failed"; fi
[[ $(cat "$TMP_DIR/aufrufe") == 3 ]] || fail "more or fewer than three attempts"
grep -q 'dreimal fehlgeschlagen' "$TMP_DIR/out" || fail "final failure not reported"
pass "update retries three times, then fails loudly"

# Regel: install reicht die Argumente unveraendert weiter, mit denselben Quellen, einmal.
lauf install -y --no-install-recommends shellcheck || fail "install failed"
grep -q '^AUFRUF .* install -y --no-install-recommends shellcheck$' "$TMP_DIR/protokoll" ||
  fail "install arguments not passed verbatim"
[[ $(cat "$TMP_DIR/aufrufe") == 1 ]] || fail "install was retried"
if grep -q 'launchpadcontent\|microsoft' "$TMP_DIR/protokoll"; then fail "install saw foreign sources"; fi
if FEHLER_BIS=1 lauf install -y paket; then fail "failed install reported success"; fi
pass "install passes its arguments verbatim against the same sources"

# Regel: ohne erlaubte Quelle kein apt-get-Aufruf; ohne Befehl Abbruch.
mkdir -p "$TMP_DIR/leer/sources.list.d"
printf 'deb https://ppa.launchpadcontent.net/x/ppa/ubuntu/ jammy main\n' >"$TMP_DIR/leer/sources.list"
rm -f "$TMP_DIR/aufrufe"
if CI_APT_ETC="$TMP_DIR/leer" CI_APT_GET="$TMP_DIR/apt-get" CI_APT_PAUSE=0 bash "$SKRIPT" update >"$TMP_DIR/out" 2>&1; then
  fail "update ran without any allowed source"
fi
grep -q 'keine erlaubte Paketquelle' "$TMP_DIR/out" || fail "missing source not reported"
[[ ! -e $TMP_DIR/aufrufe ]] || fail "apt-get called without an allowed source"
if lauf; then fail "no command accepted"; fi
[[ ! -e $TMP_DIR/aufrufe ]] || fail "apt-get called without a command"
pass "no allowed source or no command: abort before apt-get"

# Regel: die gefilterte Kopie verschwindet nach dem Lauf.
mkdir "$TMP_DIR/tmp"
TMPDIR="$TMP_DIR/tmp" lauf update || fail "update with own TMPDIR failed"
grep -q "Dir::Etc::sourceparts=$TMP_DIR/tmp/" "$TMP_DIR/protokoll" || fail "copy not created in TMPDIR"
[[ -z $(ls -A "$TMP_DIR/tmp") ]] || fail "filtered source copy left behind"
TMPDIR="$TMP_DIR/tmp" FEHLER_BIS=3 lauf update || true
[[ -z $(ls -A "$TMP_DIR/tmp") ]] || fail "filtered source copy left behind after a failure"
pass "the filtered copy of the sources is removed afterwards"

printf '\n%s ci-apt tests passed.\n' "$TESTS"
