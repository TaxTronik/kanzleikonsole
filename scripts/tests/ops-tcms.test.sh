#!/usr/bin/env bash
# =============================================================================
# Tests der TCMS-Betriebsteile der Operator-CLI (TCMS Stufe 2):
# scripts/ops/tcms.sh und die TCMS-Anteile von compose, deploy, update,
# rollback, backup, restore, doctor und provision.
#
# Aufbau wie scripts/tests/ops-lib.test.sh: jeder Test laeuft in einer eigenen
# Subshell; docker/compose sind Attrappen, die ihre Aufrufe protokollieren.
# Alle Geheimnisse sind Wegwerfwerte. Sicherheitsregeln (Netztrennung,
# Digest-/Signaturpflicht, Dateirechte, Ueberlappung, keine Werte in Ausgaben
# und Kommandozeilen) haben je einen Test, der ohne die Regel scheitert.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# shellcheck source=../ops-lib.sh
source "$REPO_ROOT/scripts/ops-lib.sh"

TESTS_RUN=0
TESTS_FAILED=0
FAILED_TESTS=()

test_fail() {
  printf 'not ok: %s\n' "$*" >&2
  exit 1
}

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf 'ok %s - %s\n' "$TESTS_RUN" "$1"
}

assert_contains() {
  local file="$1" needle="$2"
  grep -Fq -- "$needle" "$file" || {
    printf '%s\n' "--- $file ---" >&2
    sed -n '1,200p' "$file" >&2
    test_fail "expected output to contain: $needle"
  }
}

assert_not_contains() {
  local file="$1" needle="$2"
  if [[ -f "$file" ]] && grep -Fq -- "$needle" "$file"; then
    printf '%s\n' "--- $file ---" >&2
    sed -n '1,200p' "$file" >&2
    test_fail "expected output not to contain: $needle"
  fi
}

assert_key_equals() {
  local file="$1" key="$2" expected="$3" actual
  actual="$(grep -E "^${key}=" "$file" | head -n1 | cut -d= -f2- || true)"
  [[ "$actual" == "$expected" ]] || test_fail "expected ${key}=${expected}, got ${actual}"
}

env_value() { grep -E "^${2}=" "$1" | head -n1 | cut -d= -f2- || true; }

assert_before() {
  local file="$1" first="$2" second="$3" first_line second_line
  first_line="$(grep -nF -- "$first" "$file" | head -n1 | cut -d: -f1 || true)"
  second_line="$(grep -nF -- "$second" "$file" | head -n1 | cut -d: -f1 || true)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] || {
    printf '%s\n' "--- $file ---" >&2
    cat "$file" >&2
    test_fail "expected '$first' before '$second'"
  }
}

file_mode() {
  local file="$1"
  if stat -c '%a' "$file" >/dev/null 2>&1; then stat -c '%a' "$file"
  else stat -f '%Lp' "$file"; fi
}

# Spione fuer externe Programme: protokollieren die Kommandozeile und fuehren
# das echte Programm aus (siehe ops-lib.test.sh).
install_argv_spies() {
  local dir="$1" log="$2" name real
  shift 2
  mkdir -p "$dir"
  for name in "$@"; do
    real="$(command -v "$name")" || continue
    printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" %q "$*" >>%q\nexec %q "$@"\n' \
      "$name" "$log" "$real" >"$dir/$name"
    chmod +x "$dir/$name"
  done
}

run_test() {
  local name="$1" status=0 counters="$TMP_DIR/.run-test-counters" run
  rm -f -- "$counters"
  set +e
  (
    set -e
    "$name"
    printf '%s\n' "$TESTS_RUN" >"$counters"
  )
  status=$?
  set -e
  if (( status == 0 )) && [[ -s "$counters" ]]; then
    read -r run <"$counters"
    if (( run > TESTS_RUN )); then TESTS_RUN="$run"; return 0; fi
    printf 'not ok - %s (ohne pass beendet)\n' "$name" >&2
  else
    printf 'not ok - %s (Exit %s)\n' "$name" "$status" >&2
  fi
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILED_TESTS+=("$name")
}

DIGEST_API="sha256:$(printf '1%.0s' {1..64})"
DIGEST_MIGRATE="sha256:$(printf '2%.0s' {1..64})"

# Wegwerf-Git-Repository mit einer Pin-Datei; Ausgabe: Commit-SHA.
pin_repo() {
  local dir="$1" content="$2"
  mkdir -p "$dir/infra/compose"
  git -C "$dir" init -q
  printf '%s\n' "$content" >"$dir/infra/compose/tcms-release.env"
  git -C "$dir" add infra/compose/tcms-release.env
  git -C "$dir" -c user.name=test -c user.email=test@example.test commit -q -m pins
  git -C "$dir" rev-parse HEAD
}

pins_text() {
  printf 'TCMS_RELEASE_VERSION=%s\nTCMS_RELEASE_API_DIGEST=%s\nTCMS_RELEASE_MIGRATE_DIGEST=%s' "$1" "$2" "$3"
}

# ---------------------------------------------------------------------------
# Besitzvertrag und Compose-Wrapper
# ---------------------------------------------------------------------------
test_tcms_mode_defaults_to_disabled_and_rejects_unknown_values() {
  local mode
  mode="$(ENVFILE="$TMP_DIR/no-env"; TCMS_DEPLOYMENT=""; tcms_deployment_mode)"
  [[ "$mode" == "disabled" ]] || test_fail "empty TCMS_DEPLOYMENT resolved to '$mode'"
  for mode in managed external disabled; do
    [[ "$(TCMS_DEPLOYMENT="$mode" tcms_deployment_mode)" == "$mode" ]] || test_fail "$mode not accepted"
  done
  if TCMS_DEPLOYMENT=Managed tcms_deployment_mode >/dev/null; then
    test_fail "unknown TCMS_DEPLOYMENT value was accepted"
  fi
  pass "TCMS mode: empty means disabled, unknown values fail"
}

# Gemeinsame Attrappe fuer den Compose-Wrapper (Source-Kanal, keine Registry).
compose_wrapper_env() {
  local env_file="$1" mode="$2"
  {
    printf 'TAXTRONIK_DEPLOY_CHANNEL=source\nDEPLOYMENT_METHOD=standard\n'
    printf 'S3_ACCESS_KEY=wegwerfak\nS3_SECRET_KEY=wegwerfsk\n'
    printf 'TCMS_DEPLOYMENT=%s\n' "$mode"
  } >"$env_file"
}

test_compose_loads_tcms_file_only_when_managed() {
  local env_file="$TMP_DIR/compose-mode.env" calls="$TMP_DIR/compose-mode.calls" mode out
  for mode in managed external disabled ""; do
    compose_wrapper_env "$env_file" "$mode"
    : >"$calls"
    (
      ENVFILE="$env_file"
      unset TCMS_DEPLOYMENT TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX
      S3_GENERATED="$TMP_DIR/compose-mode.s3"
      docker() { printf '%s\n' "$*" >>"$calls"; }
      compose ps
    ) >/dev/null
    if [[ "$mode" == "managed" ]]; then
      assert_contains "$calls" "-f $TCMS_COMPOSE"
    else
      assert_not_contains "$calls" "docker-compose.tcms.yml"
    fi
  done
  compose_wrapper_env "$env_file" "on"
  out="$TMP_DIR/compose-mode.out"; : >"$calls"
  if (
    ENVFILE="$env_file"
    unset TCMS_DEPLOYMENT TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX
    S3_GENERATED="$TMP_DIR/compose-mode.s3"
    docker() { printf '%s\n' "$*" >>"$calls"; }
    compose ps
  ) >"$out" 2>&1; then
    test_fail "compose accepted an invalid TCMS_DEPLOYMENT"
  fi
  assert_contains "$out" "TCMS_DEPLOYMENT muss managed, external oder disabled sein"
  [[ ! -s "$calls" ]] || test_fail "compose invoked docker despite an invalid TCMS mode"
  pass "compose loads the TCMS file only for managed and stops on unknown modes"
}

# Regel: Eine globale Option vor `up` (z. B. --profile tcms) darf den
# Writer-Guard der Recovery-Marker nicht umgehen.
test_compose_writer_guard_sees_subcommand_after_global_options() {
  local pending="$TMP_DIR/guard-profile.pending" calls="$TMP_DIR/guard-profile.calls"
  local out="$TMP_DIR/guard-profile.out" args
  cat >"$pending" <<EOF
source_version=2.0.0
source_commit=$(printf 'b%.0s' {1..40})
target_version=3.0.0
target_commit=$(printf 'd%.0s' {1..40})
requires_db_restore=true
EOF
  for args in "--profile tcms up -d app" "--profile risk-layer restart app" "-p x --progress plain start app"; do
    : >"$calls"
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Argumentliste des Testfalls
    if (
      MIGRATION_PENDING="$pending"
      DB_RESTORE_AUTHORIZATION="$TMP_DIR/guard-profile.no-restore"
      render_s3_config() { :; }
      ensure_compose_image_pinning() { :; }
      reconcile_n8n_encryption_key_from_volume() { :; }
      docker() { printf '%s\n' "$*" >>"$calls"; }
      compose $args
    ) >"$out" 2>&1; then
      test_fail "compose $args bypassed the writer guard"
    fi
    assert_contains "$out" "Writer-Start blockiert"
    [[ ! -s "$calls" ]] || test_fail "compose $args reached docker"
  done
  [[ "$(compose_subcommand --profile tcms --env-file x up -d)" == "up" ]] || test_fail "subcommand parsing"
  [[ "$(compose_subcommand ps)" == "ps" ]] || test_fail "plain subcommand parsing"
  pass "compose writer guard also applies after global options such as --profile"
}

# ---------------------------------------------------------------------------
# Release-Pins (Digest- und Signaturpflicht)
# ---------------------------------------------------------------------------
test_release_pins_are_read_strictly_from_a_commit() {
  local repo="$TMP_DIR/pins-read" commit out
  commit="$(pin_repo "$repo" "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_MIGRATE")")"
  out="$(ROOT="$repo" tcms_read_release_pins "$commit")"
  [[ "$out" == "$(printf '1.4.0\n%s\n%s' "$DIGEST_API" "$DIGEST_MIGRATE")" ]] || test_fail "pins not read: $out"
  # Der Arbeitsbaum zaehlt nicht, nur der Commit.
  pins_text 9.9.9 "$DIGEST_MIGRATE" "$DIGEST_API" >"$repo/infra/compose/tcms-release.env"
  out="$(ROOT="$repo" tcms_read_release_pins "$commit")"
  [[ "$(head -n1 <<<"$out")" == "1.4.0" ]] || test_fail "pins were read from the working tree"

  local bad
  for bad in \
    "$(pins_text 1.4.0 "$DIGEST_API" "")" \
    "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_API")" \
    "$(pins_text latest "$DIGEST_API" "$DIGEST_MIGRATE")" \
    "$(pins_text 1.4.0 "sha256:abc" "$DIGEST_MIGRATE")" \
    "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_MIGRATE")"$'\nTCMS_RELEASE_VERSION=1.4.1' \
    "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_MIGRATE")"$'\nTCMS_EXTRA=1' \
    $'TCMS_RELEASE_VERSION=\nTCMS_RELEASE_API_DIGEST='; do
    rm -rf "$repo"; commit="$(pin_repo "$repo" "$bad")"
    if ROOT="$repo" tcms_read_release_pins "$commit" >/dev/null 2>&1; then
      test_fail "invalid pin file accepted: $bad"
    fi
  done
  rm -rf "$repo"; commit="$(pin_repo "$repo" "$(pins_text "" "" "")")"
  out="$(ROOT="$repo" tcms_read_release_pins "$commit")"
  [[ "$out" == $'\n\n' || -z "${out//$'\n'/}" ]] || test_fail "empty pins not accepted"
  pass "TCMS release pins are read strictly from the commit, never from the working tree"
}

registry_guard_env() {
  local env_file="$1" commit="$2" version="$3" api="$4" migrate="$5"
  {
    printf 'TAXTRONIK_DEPLOY_CHANNEL=release\nTAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik\n'
    printf 'TAXTRONIK_VERSION=2.0.0\n'
    printf 'TAXTRONIK_WEB_DIGEST_SUFFIX=@sha256:%s\n' "$(printf 'a%.0s' {1..64})"
    printf 'TAXTRONIK_WORKER_DIGEST_SUFFIX=@sha256:%s\n' "$(printf 'b%.0s' {1..64})"
    printf 'TAXTRONIK_RELEASE_COMMIT=%s\n' "$commit"
    printf 'TCMS_DEPLOYMENT=managed\nTCMS_VERSION=%s\n' "$version"
    printf 'TCMS_API_DIGEST_SUFFIX=%s\nTCMS_MIGRATE_DIGEST_SUFFIX=%s\n' "$api" "$migrate"
  } >"$env_file"
}

registry_guard_state() {
  local state="$1" commit="$2"
  {
    printf 'current=2.0.0\ncurrent_commit=%s\n' "$commit"
    printf 'current_web_digest_suffix=@sha256:%s\n' "$(printf 'a%.0s' {1..64})"
    printf 'current_worker_digest_suffix=@sha256:%s\n' "$(printf 'b%.0s' {1..64})"
  } >"$state"
}

run_registry_guard() {
  local repo="$1" env_file="$2" state="$3"
  shift 3
  (
    ROOT="$repo"; ENVFILE="$env_file"; STATE="$state"
    unset TCMS_DEPLOYMENT TCMS_VERSION TCMS_API_DIGEST_SUFFIX TCMS_MIGRATE_DIGEST_SUFFIX
    unset TAXTRONIK_DEPLOY_CHANNEL TAXTRONIK_IMAGE_PREFIX TAXTRONIK_VERSION TAXTRONIK_RELEASE_COMMIT
    unset TAXTRONIK_WEB_DIGEST_SUFFIX TAXTRONIK_WORKER_DIGEST_SUFFIX _TAXTRONIK_INTERNAL_RELEASE_CONTRACT_STAGED
    "$@"
    ensure_compose_image_pinning
  )
}

# Regel: Im Release-Kanal laufen verwaltete TCMS-Images nur mit den Digests
# des signierten (verifizierten) Release-Commits.
test_registry_compose_requires_signed_tcms_pins() {
  local repo="$TMP_DIR/pins-guard" env_file="$TMP_DIR/pins-guard.env" state="$TMP_DIR/pins-guard.state"
  local out="$TMP_DIR/pins-guard.out" commit
  commit="$(pin_repo "$repo" "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_MIGRATE")")"
  registry_guard_state "$state" "$commit"

  registry_guard_env "$env_file" "$commit" 1.4.0 "@$DIGEST_API" "@$DIGEST_MIGRATE"
  run_registry_guard "$repo" "$env_file" "$state" true >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "signed TCMS pins were rejected"
  }

  # Abweichender Digest, fremde Version, fehlender Digest.
  local case_env
  for case_env in \
    "1.4.0|@$DIGEST_MIGRATE|@$DIGEST_MIGRATE" \
    "1.4.1|@$DIGEST_API|@$DIGEST_MIGRATE" \
    "1.4.0||@$DIGEST_MIGRATE"; do
    IFS='|' read -r v a m <<<"$case_env"
    registry_guard_env "$env_file" "$commit" "$v" "$a" "$m"
    if run_registry_guard "$repo" "$env_file" "$state" true >"$out" 2>&1; then
      test_fail "unsigned TCMS image accepted: $case_env"
    fi
    assert_contains "$out" "Registry-Compose verweigert"
  done

  # Ein leerer Prozesswert verdeckt keinen .env-Digest: Compose nimmt den leeren.
  registry_guard_env "$env_file" "$commit" 1.4.0 "@$DIGEST_API" "@$DIGEST_MIGRATE"
  if run_registry_guard "$repo" "$env_file" "$state" eval 'export TCMS_API_DIGEST_SUFFIX=' >"$out" 2>&1; then
    test_fail "an empty process digest suffix bypassed the TCMS pin guard"
  fi

  # Release ohne TCMS-Pins: verwalteter Modus ist nicht betreibbar.
  rm -rf "$repo"; commit="$(pin_repo "$repo" "$(pins_text "" "" "")")"
  registry_guard_state "$state" "$commit"
  registry_guard_env "$env_file" "$commit" 1.4.0 "@$DIGEST_API" "@$DIGEST_MIGRATE"
  if run_registry_guard "$repo" "$env_file" "$state" true >"$out" 2>&1; then
    test_fail "managed TCMS accepted although the signed release pins no TCMS images"
  fi
  assert_contains "$out" "verankert kein TCMS-Release"

  # Nicht verwaltet: keine TCMS-Pruefung.
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=external/' "$env_file"
  run_registry_guard "$repo" "$env_file" "$state" true >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "external TCMS was subjected to the image pin guard"
  }
  pass "registry compose runs managed TCMS only with the digests of the signed release commit"
}

run_test test_tcms_mode_defaults_to_disabled_and_rejects_unknown_values
run_test test_compose_loads_tcms_file_only_when_managed
run_test test_compose_writer_guard_sees_subcommand_after_global_options
run_test test_release_pins_are_read_strictly_from_a_commit
run_test test_registry_compose_requires_signed_tcms_pins

if (( TESTS_FAILED > 0 )); then
  printf '\n%s ops-tcms tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s ops-tcms tests passed.\n' "$TESTS_RUN"
