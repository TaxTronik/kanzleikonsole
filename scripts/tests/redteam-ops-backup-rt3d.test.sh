#!/usr/bin/env bash
# =============================================================================
# Angriffsdurchlauf RT3D (kk-tcms-s11 Punkt 6): Zeitplan und Rotation der
# TCMS-Sicherung (scripts/ops/backup.sh). Ausgefuehrte Angriffe, kein Befund:
#   - tcms_backup_cron_line weist Pfade mit ', %, Zeilenumbruch oder Backslash
#     ab (Crontab-/Shell-Injektion) und zitiert sonst einfach (Leerzeichen,
#     $-Zeichen bleiben literal).
#   - tcms_backup_rotate loescht nur streng benannte Dumps im eigenen
#     Verzeichnis, nie fremde Dateien, folgt keinem Symlink auf ein Ziel
#     ausserhalb und behaelt die neuesten <keep> Paare (Dump + .sha256).
#   - tcms_backup_keep nimmt nur 1..365 an; 0, 366, Nichtzahlen und
#     Shell-Syntax werden abgewiesen (kein Default-Fallback bei ungueltigem Wert).
#
# Nutzt die Hilfen aus ops-tcms.test.sh (alles vor dessen run_test-Aufrufen);
# backup.sh wird ueber ops-lib.sh geladen. Aufruf:
#   bash scripts/tests/redteam-ops-backup-rt3d.test.sh
# =============================================================================
set -euo pipefail

RT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1090 # Hilfen der bestehenden Suite, ohne deren Testlauf
source <(sed -e '/^run_test test_/,$d' \
  -e "s|^REPO_ROOT=.*|REPO_ROOT=\"$RT_ROOT\"|" "$RT_ROOT/scripts/tests/ops-tcms.test.sh")

# Regel: Die Cron-Zeile wird einfach zitiert; Pfade mit ', %, Zeilenumbruch oder
# Backslash werden abgewiesen statt falsch maskiert.
test_rt3d_cron_line_rejects_injection_and_quotes_safely() {
  local out="$TMP_DIR/cron.out" root log
  log="$TMP_DIR/zeitplan.log"
  for root in "/srv/it's-mine" "/srv/pct%d" $'/srv/a\nb' '/srv/back\slash'; do
    if tcms_backup_cron_line "$root" "$log" >"$out" 2>&1; then
      test_fail "cron line accepted a dangerous path: $(printf %q "$root")"
    fi
  done
  # Auch ein gefaehrliches Log-Ziel wird abgewiesen.
  if tcms_backup_cron_line "/srv/app" "/var/log/it's.log" >"$out" 2>&1; then
    test_fail "cron line accepted a dangerous log path"
  fi
  # Harmloser Pfad mit Leerzeichen und $-Zeichen: akzeptiert, einfach zitiert,
  # unter /bin/sh nicht expandiert.
  tcms_backup_cron_line '/srv/my app/$HOME' "$log" >"$out" 2>&1 \
    || test_fail "cron line refused a harmless path with space/dollar"
  assert_contains "$out" "cd '/srv/my app/\$HOME' && ./taxtronik tcms backup --zeitplan"
  grep -Fq -- "30 1 * * *" "$out" || test_fail "cron line lost its schedule"
  # Keine unmaskierten Metazeichen ausserhalb der einfachen Quotes.
  grep -Eq "[^']\\\$\(|;\s*rm|&&\s*rm" "$out" && test_fail "cron line contains unquoted metachars"
  pass "cron line rejects ', %, newline, backslash and single-quotes everything else"
}

# Regel: Rotation nur im eigenen Verzeichnis, nur streng benannte Dumps, nie
# fremde Dateien, kein Symlink auf ein Ziel ausserhalb, neueste <keep> bleiben.
test_rt3d_rotate_stays_in_dir_and_ignores_foreign_and_symlinks() {
  local dir="$TMP_DIR/rot" aussen="$TMP_DIR/aussen" i name
  mkdir -p "$dir" "$aussen"
  # Datei ausserhalb, auf die ein Symlink im Verzeichnis zeigt.
  printf 'GEHEIM' >"$aussen/opfer.dump"
  # 16 regulaere, gueltig benannte Dumps (plus .sha256), aufsteigend sortierbar.
  for i in $(seq 1 16); do
    name="$(printf 'tcms-db-202001%02d-0000%02d-a%02d.dump' "$i" "$i" "$i")"
    : >"$dir/$name"; : >"$dir/$name.sha256"
  done
  # Fremde Dateien, die nie angefasst werden duerfen.
  : >"$dir/keep.me"
  : >"$dir/tcms-db-evil.dump"            # Namensform passt nicht (kein Datum)
  : >"$dir/tcms-db-20200101-000000-toolongsuffix.dump"  # Suffix > 5
  # Symlink mit sonst gueltigem Namen auf ein Ziel ausserhalb.
  ln -s "$aussen/opfer.dump" "$dir/tcms-db-20190101-000000-lnk.dump"

  tcms_backup_rotate "$dir" 14 >/dev/null 2>&1 || test_fail "rotate failed"

  # Ziel ausserhalb unversehrt (Symlink nie gefolgt).
  [[ -f "$aussen/opfer.dump" && "$(cat "$aussen/opfer.dump")" == "GEHEIM" ]] \
    || test_fail "rotate followed a symlink out of the directory"
  # Fremde Dateien unberuehrt.
  [[ -f "$dir/keep.me" && -f "$dir/tcms-db-evil.dump" \
     && -f "$dir/tcms-db-20200101-000000-toolongsuffix.dump" ]] \
    || test_fail "rotate removed a non-matching file"
  # Genau 14 gueltige Dumps bleiben, Paare (Dump + .sha256) zusammen.
  local verblieben
  verblieben="$(find "$dir" -maxdepth 1 -type f -name 'tcms-db-*.dump' \
    -regextype posix-extended -regex '.*/tcms-db-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{1,5}\.dump' | wc -l)"
  [[ "$verblieben" -eq 14 ]] || test_fail "rotate kept $verblieben valid dumps, expected 14"
  # Zu jedem verbliebenen Dump existiert die .sha256-Beidatei.
  while IFS= read -r name; do
    [[ -f "$name.sha256" ]] || test_fail "rotate orphaned a sha256 sidecar: $name"
  done < <(find "$dir" -maxdepth 1 -type f -name 'tcms-db-*.dump' \
    -regextype posix-extended -regex '.*/tcms-db-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{1,5}\.dump')
  # Der aelteste (2019, der Symlink) wurde als Link entfernt, das Ziel nicht.
  [[ ! -e "$dir/tcms-db-20190101-000000-lnk.dump" ]] || test_fail "oldest link not rotated"
  pass "rotate stays in the directory, keeps the newest 14 pairs, never follows symlinks or touches foreign files"
}

# Regel: keep ist 1..365; ungueltige Werte werden abgewiesen (kein Fallback).
test_rt3d_backup_keep_bounds() {
  local wert rc
  for wert in 0 366 400 abc '5; rm -rf /' '-1' '01'; do
    rc=0; TCMS_BACKUP_KEEP="$wert" tcms_backup_keep >/dev/null 2>&1 || rc=$?
    [[ "$rc" -ne 0 ]] || test_fail "tcms_backup_keep accepted invalid value: $(printf %q "$wert")"
  done
  for wert in 1 14 365; do
    [[ "$(TCMS_BACKUP_KEEP="$wert" tcms_backup_keep)" == "$wert" ]] \
      || test_fail "tcms_backup_keep rejected valid value: $wert"
  done
  # Leer → Default 14.
  local leer; unset TCMS_BACKUP_KEEP; leer="$(tcms_backup_keep)"
  [[ "$leer" == "14" ]] || test_fail "tcms_backup_keep default is not 14 (got $leer)"
  pass "tcms_backup_keep accepts only 1..365 and defaults to 14, never falls back on an invalid value"
}

run_test test_rt3d_cron_line_rejects_injection_and_quotes_safely
run_test test_rt3d_rotate_stays_in_dir_and_ignores_foreign_and_symlinks
run_test test_rt3d_backup_keep_bounds

if (( TESTS_FAILED > 0 )); then
  printf '\n%s red-team ops-backup tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s red-team ops-backup tests passed.\n' "$TESTS_RUN"
