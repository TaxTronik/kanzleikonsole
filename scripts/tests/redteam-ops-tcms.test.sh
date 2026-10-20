#!/usr/bin/env bash
# =============================================================================
# Red Team kk-tcms-redteam3b: ausgefuehrte Angriffe auf die Betriebsbefehle
# des TCMS-Code-Schluessels (scripts/ops/tcms.sh, scripts/ops/doctor.sh):
# `tcms setup`, `tcms rotate-code-key [--finish]`, `doctor`, `tcms status`
# und die Vorabpruefung von deploy/update mit manipulierten Zustandsdateien
# (Symlink, haengender Symlink, Shell-Syntax, CRLF, doppelte Schluessel),
# Sonderzeichen und Dubletten in der .env und Spionen auf allen externen
# Programmen (Geheimnisse in argv, Ausgaben, Dateien).
#
# Nutzt die Attrappen und Hilfen aus ops-tcms.test.sh (alles vor dessen
# run_test-Aufrufen); docker/compose sind Attrappen, alle Geheimnisse
# Wegwerfwerte. Aufruf: bash scripts/tests/redteam-ops-tcms.test.sh
# =============================================================================
set -euo pipefail

RT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1090 # Hilfen der bestehenden Suite, ohne deren Testlauf
source <(sed -e '/^run_test test_/,$d' \
  -e "s|^REPO_ROOT=.*|REPO_ROOT=\"$RT_ROOT\"|" "$RT_ROOT/scripts/tests/ops-tcms.test.sh")

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# Startet eine echte Rotation und laesst sie 8 Tage laufen (Phase published).
rotation_laeuft() {
  local env_file="$1"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  run_code_rotation "$env_file" >/dev/null 2>&1 || test_fail "rotation start failed"
  printf '%s' $(( 1700000000 + 8 * 86400 )) >"$CLOCK"
  : >"$CALLS"
}

# Regel: Der Rotationszustand ist nur als eigene, regulaere 0600-Datei gueltig;
# ein Symlink wird weder gelesen noch beschrieben (auch nicht haengend).
test_rt3b_state_symlinks_are_refused_and_never_followed() {
  local env_file="$TMP_DIR/rt-link.env" out="$TMP_DIR/rt-link.out" ziel="$TMP_DIR/rt-link.ziel"
  local env_vorher ziel_vorher
  export CALLS="$TMP_DIR/rt-link.calls" CLOCK="$TMP_DIR/rt-link.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/rt-link.rotation" INSTALL_STATE="$TMP_DIR/rt-link.state"
  rotation_laeuft "$env_file"
  # Gueltiger Zustand, aber ueber einen Symlink erreichbar.
  mv "$CODE_ROTATION_STATE" "$ziel"; ln -s "$ziel" "$CODE_ROTATION_STATE"
  env_vorher="$(sha_of "$env_file")"; ziel_vorher="$(sha_of "$ziel")"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "finish through a symlinked state"; fi
  assert_contains "$out" "keine regulaere Datei"
  if run_code_rotation "$env_file" >"$out" 2>&1; then test_fail "start through a symlinked state"; fi
  run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "WARN     TCMS_CODE_ROTATION     Rotationszustand keine regulaere Datei"
  [[ "$(sha_of "$env_file")" == "$env_vorher" && "$(sha_of "$ziel")" == "$ziel_vorher" ]] || \
    test_fail "refused commands changed .env or the symlink target"
  [[ -L "$CODE_ROTATION_STATE" && ! -s "$CALLS" ]] || test_fail "refused commands had side effects"
  # Haengender Symlink an der Zustandsstelle vor einem neuen Start: das Ziel
  # entsteht nie (mv ersetzt den Link, folgt ihm nicht).
  rm -f "$CODE_ROTATION_STATE" "$ziel"
  managed_env "$env_file"
  ln -s "$TMP_DIR/rt-link.nie" "$CODE_ROTATION_STATE"
  printf '1700000000' >"$CLOCK"
  run_code_rotation "$env_file" >"$out" 2>&1 || true
  [[ ! -e "$TMP_DIR/rt-link.nie" ]] || test_fail "dangling symlink target was written"
  pass "symlinked rotation state is refused by rotate-code-key and doctor; links are never followed"
}

# Regel: Inhalte des Zustands werden nie ausgefuehrt; jede Abweichung vom
# Format (Shell-Syntax, CRLF, doppelte oder ueberlange Werte) wird abgewiesen.
test_rt3b_state_with_shell_syntax_crlf_and_duplicates_is_refused() {
  local env_file="$TMP_DIR/rt-inj.env" out="$TMP_DIR/rt-inj.out" gut="$TMP_DIR/rt-inj.gut"
  local pwned="$TMP_DIR/rt-inj.PWNED" variante env_vorher
  export CALLS="$TMP_DIR/rt-inj.calls" CLOCK="$TMP_DIR/rt-inj.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/rt-inj.rotation" INSTALL_STATE="$TMP_DIR/rt-inj.state"
  rotation_laeuft "$env_file"
  cp "$CODE_ROTATION_STATE" "$gut"
  env_vorher="$(sha_of "$env_file")"
  for variante in phase-subst epoch-subst crlf phase-doppelt epoch-11 id-backtick; do
    cp "$gut" "$CODE_ROTATION_STATE"; chmod 0600 "$CODE_ROTATION_STATE"
    case "$variante" in
      phase-subst) sed -i "s|^phase=.*|phase=published\$(touch $pwned)|" "$CODE_ROTATION_STATE" ;;
      epoch-subst) sed -i "s|^published_at_epoch=.*|published_at_epoch=1600000000;touch $pwned|" "$CODE_ROTATION_STATE" ;;
      crlf) sed -i 's/$/\r/' "$CODE_ROTATION_STATE" ;;
      phase-doppelt) printf 'phase=published\n' >>"$CODE_ROTATION_STATE" ;;
      epoch-11) sed -i 's|^published_at_epoch=.*|published_at_epoch=16000000000|' "$CODE_ROTATION_STATE" ;;
      id-backtick) sed -i "s|^new_id=.*|new_id=csk:\`touch $pwned\`|" "$CODE_ROTATION_STATE" ;;
    esac
    if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "manipulated state accepted ($variante)"; fi
    run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
    assert_contains "$out" "WARN     TCMS_CODE_ROTATION"
    tcms_isolated "$env_file" eval 'load_env; docker() { return 1; }; cmd_tcms_status' >"$out" 2>&1 || true
  done
  [[ ! -e "$pwned" ]] || test_fail "content of the rotation state was executed"
  [[ "$(sha_of "$env_file")" == "$env_vorher" && ! -s "$CALLS" ]] || test_fail "refusals had side effects"
  # Unbekannte Zusatzzeile mit Shell-Syntax: ignoriert, nie ausgefuehrt.
  cp "$gut" "$CODE_ROTATION_STATE"; chmod 0600 "$CODE_ROTATION_STATE"
  printf 'x=$(touch %s)\n' "$pwned" >>"$CODE_ROTATION_STATE"
  run_code_rotation "$env_file" --finish >"$out" 2>&1 || { cat "$out" >&2; test_fail "finish with extra line failed"; }
  [[ ! -e "$pwned" ]] || test_fail "extra line of the rotation state was executed"
  pass "rotation state with shell syntax, CRLF, duplicate or overlong values is refused and never executed"
}

# Regel: Werte der .env werden nie ausgefuehrt; ein Code-Schluessel mit
# Shell-Syntax ist ungueltig (doctor FEHLT, Vorabpruefung bricht ab, setup
# erzeugt keinen neuen und aendert die .env nicht), ohne den Wert zu nennen.
test_rt3b_env_values_with_shell_syntax_fail_closed_without_execution() {
  local env_file="$TMP_DIR/rt-envsub.env" out="$TMP_DIR/rt-envsub.out" pwned="$TMP_DIR/rt-envsub.PWNED"
  local wert vorher
  export CALLS="$TMP_DIR/rt-envsub.calls" CLOCK="$TMP_DIR/rt-envsub.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/rt-envsub.rotation" INSTALL_STATE="$TMP_DIR/rt-envsub.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  for wert in "\$(touch $pwned)AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" \
    "\`touch $pwned\`AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" \
    "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789;touch $pwned"; do
    sed -i '/^TCMS_CODE_SCHLUESSEL=/d' "$env_file"
    printf 'TCMS_CODE_SCHLUESSEL=%s\n' "$wert" >>"$env_file"
    vorher="$(sha_of "$env_file")"
    run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
    assert_contains "$out" "FEHLT    TCMS_CODE_SCHLUESSEL"
    assert_no_secret "$out" "$wert" TCMS_CODE_SCHLUESSEL
    if tcms_isolated "$env_file" eval 'load_env; tcms_preflight_for_deploy' >"$out" 2>&1; then
      test_fail "deploy preflight accepted a code key with shell syntax"
    fi
    assert_no_secret "$out" "$wert" TCMS_CODE_SCHLUESSEL
    if run_code_rotation "$env_file" >"$out" 2>&1; then test_fail "rotation accepted a code key with shell syntax"; fi
    if tcms_isolated "$env_file" eval 'load_env; tcms_configure_managed' >"$out" 2>&1; then
      test_fail "setup accepted a code key with shell syntax"
    fi
    assert_no_secret "$out" "$wert" TCMS_CODE_SCHLUESSEL
    [[ "$(sha_of "$env_file")" == "$vorher" ]] || test_fail "refused setup changed the .env"
  done
  [[ ! -e "$pwned" && ! -s "$CALLS" ]] || test_fail "a .env value was executed or caused a restart"
  pass ".env values with shell syntax are refused everywhere, never executed and never printed"
}

# Regel: Bei doppelten Zeilen fuer den Code-Schluessel pruefen doctor und die
# Vorabpruefung genau den Wert, den Compose bekommt: load_env exportiert die
# letzte Zeile (deploy/update laden die .env vor der Vorabpruefung), und
# Compose bevorzugt die Prozessumgebung. get_env (erste Zeile) entscheidet
# hier nichts.
test_rt3b_duplicate_code_key_lines_are_checked_as_compose_sees_them() {
  local env_file="$TMP_DIR/rt-dup.env" out="$TMP_DIR/rt-dup.out" key token
  export CALLS="$TMP_DIR/rt-dup.calls" CLOCK="$TMP_DIR/rt-dup.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/rt-dup.rotation" INSTALL_STATE="$TMP_DIR/rt-dup.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  key="$(code_key_of "$env_file")"; token="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  # Erste Zeile gueltig, zweite gleich dem Dienst-Token (der Dienst startet nicht).
  printf 'TCMS_CODE_SCHLUESSEL=%s\n' "$token" >>"$env_file"
  run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "FEHLT    TCMS_CODE_SCHLUESSEL"
  if tcms_isolated "$env_file" eval 'load_env; tcms_preflight_for_deploy' >"$out" 2>&1; then
    test_fail "deploy preflight accepted duplicate code key lines"
  fi
  # Umgekehrt: erste Zeile ungueltig, letzte gueltig – geprueft wird die letzte,
  # und genau sie erreicht Compose.
  sed -i '/^TCMS_CODE_SCHLUESSEL=/d' "$env_file"
  printf 'TCMS_CODE_SCHLUESSEL=%s\nTCMS_CODE_SCHLUESSEL=%s\n' "$token" "$key" >>"$env_file"
  run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "OK       TCMS_CODE_SCHLUESSEL"
  tcms_isolated "$env_file" eval 'load_env; tcms_preflight_for_deploy
    printf "%s" "$TCMS_CODE_SCHLUESSEL" | sha256sum | cut -c1-64' >"$out" 2>&1 || \
    test_fail "deploy preflight refused the valid last line"
  [[ "$(tail -n1 "$out")" == "$(printf '%s' "$key" | sha256sum | cut -c1-64)" ]] || \
    test_fail "the checked value is not the one Compose receives"
  assert_no_secret "$out" "$key" TCMS_CODE_SCHLUESSEL
  assert_no_secret "$out" "$token" TCMS_SERVICE_TOKEN
  pass "duplicate code key lines are checked exactly as Compose receives them (last line)"
}

# Regel: Auch doctor, status und die Vorabpruefung geben keinen Wert an ein
# externes Programm, in die Ausgabe oder in eine Datei (Spione auf argv).
test_rt3b_doctor_status_preflight_never_expose_secrets() {
  local env_file="$TMP_DIR/rt-spy.env" spies="$TMP_DIR/rt-spy-bin" log="$TMP_DIR/rt-spy.log"
  local out="$TMP_DIR/rt-spy.out" key value
  export CALLS="$TMP_DIR/rt-spy.calls" CLOCK="$TMP_DIR/rt-spy.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/rt-spy.rotation" INSTALL_STATE="$TMP_DIR/rt-spy.state"
  rotation_laeuft "$env_file"
  : >"$log"
  install_argv_spies "$spies" "$log" openssl base64 tr sha256sum cut grep sed cat mv chmod mktemp head date rm cp stat id awk curl
  tcms_isolated "$env_file" eval '
    PATH="'"$spies"':$PATH"
    docker() { printf "docker %s\n" "$*" >>"'"$CALLS"'"; return 1; }
    compose() { printf "compose %s\n" "$*" >>"'"$CALLS"'"; return 1; }
    tcms_now() { printf 1700100000; }
    load_env
    _DOCTOR_ERRS=0; _DOCTOR_WARNS=0
    _TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1
    _doctor_tcms
    tcms_preflight_for_deploy
    cmd_tcms_status
  ' >"$out" 2>&1 || true
  [[ -s "$log" ]] || test_fail "argv spies were not used"
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD \
    TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY TCMS_CODE_SCHLUESSEL; do
    value="$(env_value "$env_file" "$key")"
    [[ -n "$value" ]] || test_fail "$key missing"
    # Jeder Eintrag einer Liste einzeln (Code-Schluessel NEU,ALT).
    while IFS= read -r -d ',' teil; do
      assert_no_secret "$log" "$teil" "$key"
      assert_no_secret "$out" "$teil" "$key"
      assert_no_secret "$CALLS" "$teil" "$key"
      assert_no_secret "$CODE_ROTATION_STATE" "$teil" "$key"
    done < <(printf '%s,' "$value")
  done
  pass "doctor, status and the deploy preflight keep every TCMS secret out of argv, output and state"
}

run_test test_rt3b_state_symlinks_are_refused_and_never_followed
run_test test_rt3b_state_with_shell_syntax_crlf_and_duplicates_is_refused
run_test test_rt3b_env_values_with_shell_syntax_fail_closed_without_execution
run_test test_rt3b_duplicate_code_key_lines_are_checked_as_compose_sees_them
run_test test_rt3b_doctor_status_preflight_never_expose_secrets

if (( TESTS_FAILED > 0 )); then
  printf '\n%s red-team ops-tcms tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s red-team ops-tcms tests passed.\n' "$TESTS_RUN"
