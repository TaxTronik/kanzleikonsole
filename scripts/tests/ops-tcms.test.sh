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

# ---------------------------------------------------------------------------
# Einrichtung, Schluesselformat, Rotation, Abschalten (tcms setup/rotate/disable)
# ---------------------------------------------------------------------------
NODE_BIN="$(command -v node)"

# Basis-.env eines verwalteten Tax-CMS im Source-Kanal (lokaler Tag).
tcms_base_env() {
  local env_file="$1"
  {
    printf 'NODE_ENV=production\nTAXTRONIK_DEPLOY_CHANNEL=source\nTAXTRONIK_IMAGE_PREFIX=taxtronik\n'
    printf 'DEPLOYMENT_METHOD=standard\nS3_ACCESS_KEY=wegwerfak\nS3_SECRET_KEY=wegwerfsk\n'
    printf 'POSTGRES_PASSWORD=wegwerf-kk-superuser-0123456789\n'
    printf 'TCMS_VERSION=0.9.0-dev\n'
  } >"$env_file"
  chmod 0600 "$env_file"
}

# Fuehrt einen Befehl mit isolierter TCMS-Umgebung aus: keine geerbten
# Konfigurationswerte; die Konstanten aus scripts/ops/tcms.sh bleiben, damit
# eine Aenderung dort (z. B. der Wartezeit) die Tests trifft.
TCMS_CONFIG_VARS=(TCMS_DEPLOYMENT TCMS_URL TCMS_SERVICE_TOKEN TCMS_SERVICE_TOKENS
  TCMS_ACTOR_PRIVATE_KEY TCMS_ACTOR_KEY_ID TCMS_ACTOR_PUBLIC_KEYS TCMS_DB_SUPERUSER_PASSWORD
  TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD TCMS_VERSION TCMS_API_DIGEST_SUFFIX
  TCMS_MIGRATE_DIGEST_SUFFIX TCMS_SERVICE_TOKEN_NEXT TCMS_ACTOR_PRIVATE_KEY_NEXT TCMS_ACTOR_KEY_ID_NEXT)
tcms_isolated() {
  local env_file="$1"
  shift
  (
    unset "${TCMS_CONFIG_VARS[@]}"
    TCMS_ROTATION_STATE="${ROTATION_STATE:-$TMP_DIR/no-rotation}"
    ENVFILE="$env_file"
    STATE="${INSTALL_STATE:-$TMP_DIR/no-install-state}"
    "$@"
  )
}

managed_env() {
  local env_file="$1"
  tcms_base_env "$env_file"
  tcms_isolated "$env_file" eval 'load_env; tcms_configure_managed' >/dev/null
}

# Prueft das Schluesselmaterial mit node:crypto wie parsePrivatenSchluessel und
# parseSchluesselListe des TCMS-Vertrags (PKCS8/SPKI-DER, Ed25519, kanonisch,
# Paar passt, Signatur verifiziert).
assert_contract_keys() {
  local env_file="$1"
  TCMS_PRIV="$(env_value "$env_file" TCMS_ACTOR_PRIVATE_KEY)" \
  TCMS_KID="$(env_value "$env_file" TCMS_ACTOR_KEY_ID)" \
  TCMS_KEYS="$(env_value "$env_file" TCMS_ACTOR_PUBLIC_KEYS)" \
  "$NODE_BIN" --input-type=module -e '
    import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
    const strict = (t) => { const b = Buffer.from(t, "base64"); if (b.toString("base64") !== t) throw new Error("nicht kanonisch"); return b; };
    const priv = createPrivateKey({ key: strict(process.env.TCMS_PRIV), format: "der", type: "pkcs8" });
    if (priv.asymmetricKeyType !== "ed25519") throw new Error("privat kein Ed25519");
    const map = new Map(process.env.TCMS_KEYS.split(",").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(process.env.TCMS_KID)) throw new Error("kid");
    const der = strict(map.get(process.env.TCMS_KID));
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    if (pub.asymmetricKeyType !== "ed25519" || !pub.export({ format: "der", type: "spki" }).equals(der)) throw new Error("spki");
    if (!createPublicKey(priv).export({ format: "der", type: "spki" }).equals(der)) throw new Error("Paar passt nicht");
    const data = Buffer.from("header.payload");
    if (!verify(null, data, pub, sign(null, data, priv))) throw new Error("Signatur");
  ' || test_fail "generated key material does not match the TCMS contract"
}

test_managed_setup_generates_contract_conform_secrets_once() {
  local env_file="$TMP_DIR/setup-managed.env" before after key
  managed_env "$env_file"
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
    [[ "$(env_value "$env_file" "$key")" =~ ^[A-Za-z0-9_-]{43}$ ]] || test_fail "$key not generated"
  done
  [[ "$(env_value "$env_file" TCMS_DB_SUPERUSER_PASSWORD)" != "$(env_value "$env_file" TCMS_DB_OWNER_PASSWORD)" && \
     "$(env_value "$env_file" TCMS_DB_OWNER_PASSWORD)" != "$(env_value "$env_file" TCMS_DB_APP_PASSWORD)" ]] || \
    test_fail "TCMS database passwords are not distinct"
  assert_key_equals "$env_file" TCMS_DEPLOYMENT managed
  assert_key_equals "$env_file" TCMS_URL "http://tcms-api:3200"
  [[ "$(env_value "$env_file" TCMS_SERVICE_TOKENS)" == "$(env_value "$env_file" TCMS_SERVICE_TOKEN)" ]] || \
    test_fail "service token list does not hold exactly the current token"
  [[ "$(env_value "$env_file" TCMS_ACTOR_KEY_ID)" =~ ^kk-[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9_-]{8}$ ]] || \
    test_fail "kid does not follow the akteur:schluessel format"
  assert_contract_keys "$env_file"
  [[ "$(file_mode "$env_file")" == "600" ]] || test_fail ".env is not 0600 after setup"
  before="$(cat "$env_file")"
  tcms_isolated "$env_file" eval 'load_env; tcms_configure_managed' >/dev/null
  after="$(cat "$env_file")"
  [[ "$before" == "$after" ]] || test_fail "a second setup rotated existing TCMS secrets"
  pass "managed setup creates contract-conform secrets once and keeps them afterwards"
}

# Regel: kein Geheimnis in Kommandozeilen (Prozessliste) oder Ausgaben.
test_setup_and_rotation_never_expose_secrets() {
  local env_file="$TMP_DIR/setup-argv.env" spies="$TMP_DIR/setup-argv-spies" log="$TMP_DIR/setup-argv.log"
  local out="$TMP_DIR/setup-argv.out" calls="$TMP_DIR/setup-argv.calls" key value
  tcms_base_env "$env_file"
  : >"$log"; : >"$calls"
  install_argv_spies "$spies" "$log" openssl base64 tr sha256sum cut grep sed cat mv chmod mktemp head date rm
  ROTATION_STATE="$TMP_DIR/setup-argv.rotation" INSTALL_STATE="$TMP_DIR/setup-argv.state" \
  tcms_isolated "$env_file" eval '
    PATH="'"$spies"':$PATH"
    compose() { printf "compose %s\n" "$*" >>"'"$calls"'"; }
    docker() { printf "docker %s\n" "$*" >>"'"$calls"'"; }
    smoke_health() { :; }
    FAKE_NOW=1700000000
    tcms_now() { printf "%s" "$FAKE_NOW"; }
    tcms_sleep() { FAKE_NOW=$(( FAKE_NOW + $1 )); }
    load_env
    tcms_configure_managed
    cmd_tcms_rotate token
    cmd_tcms_rotate key
    cmd_tcms_status
  ' >"$out" 2>&1 || { cat "$out" >&2; test_fail "setup/rotation failed"; }
  [[ -s "$log" ]] || test_fail "argv spies were not used"
  assert_contains "$log" "openssl genpkey -algorithm ed25519"
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD \
    TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY; do
    value="$(env_value "$env_file" "$key")"
    [[ -n "$value" ]] || test_fail "$key missing after setup"
    assert_not_contains "$log" "$value"
    assert_not_contains "$calls" "$value"
    assert_not_contains "$out" "$value"
  done
  pass "setup and rotation keep every TCMS secret out of command lines, docker calls and output"
}

# Compose-Attrappe fuer Rotationen: protokolliert je Neustart, welche Werte
# tcms-api bzw. app/worker in diesem Moment bekommen (nur Kennungen).
rotation_stubs() {
  cat <<'STUBS'
compose() {
  local args="$*" ids="" entry
  local -a entries
  if [[ "$args" == *"tcms-api"* ]]; then
    IFS=',' read -r -a entries <<<"$TCMS_SERVICE_TOKENS"
    for entry in "${entries[@]}"; do ids+="$(tcms_token_id "$entry") "; done
    printf 'API t=%s tokens=%s kids=%s\n' "$FAKE_NOW" "$ids" "$(tcms_kids_of_list "$TCMS_ACTOR_PUBLIC_KEYS")" >>"$CALLS"
    [[ -z "${FAIL_API_ONCE:-}" || -e "$FAIL_API_ONCE" ]] || { : >"$FAIL_API_ONCE"; return 1; }
  elif [[ "$args" == *"app worker"* ]]; then
    printf 'WRITERS t=%s token=%s kid=%s\n' "$FAKE_NOW" "$(tcms_token_id "$TCMS_SERVICE_TOKEN")" "$TCMS_ACTOR_KEY_ID" >>"$CALLS"
    [[ -z "${FAIL_WRITERS_ONCE:-}" || -e "$FAIL_WRITERS_ONCE" ]] || { : >"$FAIL_WRITERS_ONCE"; return 1; }
  fi
  return 0
}
docker() { return 0; }
smoke_health() { :; }
tcms_now() { printf '%s' "$FAKE_NOW"; }
tcms_sleep() {
  FAKE_NOW=$(( FAKE_NOW + $1 ))
  printf '%s' "$FAKE_NOW" >"$CLOCK"
  if [[ -n "${ABORT_AFTER:-}" ]] && (( FAKE_NOW >= ABORT_AFTER )); then exit 130; fi
}
STUBS
}

run_rotation() {
  local env_file="$1" kind="$2"
  tcms_isolated "$env_file" eval "$(rotation_stubs)"'
    FAKE_NOW="$(cat "$CLOCK")"
    cmd_tcms_rotate '"$kind"
}

# Regel: Ueberlappung. tcms-api kennt alt+neu, bevor app/worker umstellen;
# der alte Eintrag verschwindet erst danach (Schluessel: >= 300 s spaeter).
test_token_rotation_overlaps_and_retires_the_old_token() {
  local env_file="$TMP_DIR/rot-token.env" old new old_id new_id
  export CALLS="$TMP_DIR/rot-token.calls" CLOCK="$TMP_DIR/rot-token.clock"
  export ROTATION_STATE="$TMP_DIR/rot-token.rotation" INSTALL_STATE="$TMP_DIR/rot-token.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  old="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  run_rotation "$env_file" token >/dev/null 2>&1 || test_fail "token rotation failed"
  new="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  [[ "$new" != "$old" ]] && tcms_valid_token "$new" || test_fail "token was not replaced by a valid token"
  old_id="$(tcms_token_id "$old")"; new_id="$(tcms_token_id "$new")"
  [[ "$(grep -c '' "$CALLS")" == "3" ]] || { cat "$CALLS" >&2; test_fail "expected api, writers, api"; }
  [[ "$(sed -n 1p "$CALLS")" == "API t=1700000000 tokens=$old_id $new_id  kids="* ]] || test_fail "api did not get old+new first"
  [[ "$(sed -n 2p "$CALLS")" == "WRITERS t=1700000000 token=$new_id "* ]] || test_fail "writers did not switch second"
  [[ "$(sed -n 3p "$CALLS")" == "API t=1700000000 tokens=$new_id  kids="* ]] || test_fail "old token not retired last"
  assert_key_equals "$env_file" TCMS_SERVICE_TOKENS "$new"
  assert_key_equals "$env_file" TCMS_SERVICE_TOKEN_NEXT ""
  [[ ! -e "$ROTATION_STATE" ]] || test_fail "rotation state left behind"
  pass "token rotation: api accepts old+new, writers switch, then the old token is removed"
}

test_key_rotation_waits_five_minutes_before_removing_the_old_key() {
  local env_file="$TMP_DIR/rot-key.env" old_kid new_kid switched removed
  export CALLS="$TMP_DIR/rot-key.calls" CLOCK="$TMP_DIR/rot-key.clock"
  export ROTATION_STATE="$TMP_DIR/rot-key.rotation" INSTALL_STATE="$TMP_DIR/rot-key.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  old_kid="$(env_value "$env_file" TCMS_ACTOR_KEY_ID)"
  run_rotation "$env_file" key >/dev/null 2>&1 || test_fail "key rotation failed"
  new_kid="$(env_value "$env_file" TCMS_ACTOR_KEY_ID)"
  [[ "$new_kid" != "$old_kid" ]] || test_fail "kid did not change"
  [[ "$(sed -n 1p "$CALLS")" == "API "*"kids=$old_kid, $new_kid" ]] || { cat "$CALLS" >&2; test_fail "api did not get both keys first"; }
  [[ "$(sed -n 2p "$CALLS")" == "WRITERS "*"kid=$new_kid" ]] || test_fail "writers did not switch to the new key"
  [[ "$(sed -n 3p "$CALLS")" == "API "*"kids=$new_kid" ]] || test_fail "old key not removed last"
  switched="$(sed -n 2p "$CALLS" | sed -E 's/^WRITERS t=([0-9]+).*/\1/')"
  removed="$(sed -n 3p "$CALLS" | sed -E 's/^API t=([0-9]+).*/\1/')"
  (( removed - switched >= 300 )) || test_fail "old key removed after $(( removed - switched )) s (< 300)"
  assert_contract_keys "$env_file"
  [[ "$(env_value "$env_file" TCMS_ACTOR_PUBLIC_KEYS)" == "$new_kid="* && \
     "$(env_value "$env_file" TCMS_ACTOR_PUBLIC_KEYS)" != *,* ]] || test_fail "public key list not reduced to the new key"
  assert_key_equals "$env_file" TCMS_ACTOR_PRIVATE_KEY_NEXT ""
  pass "key rotation keeps the old public key for at least 300 s after the writers switched"
}

# Regel: Wiederaufnahme nach Abbruch ueber die Zustandsdatei, ohne neues
# Geheimnis und ohne die Wartezeit zu verkuerzen; Zustand ohne Geheimnisse, 0600.
test_rotation_resumes_after_interruptions() {
  local env_file="$TMP_DIR/rot-resume.env" kid_after_first state_text value
  export CALLS="$TMP_DIR/rot-resume.calls" CLOCK="$TMP_DIR/rot-resume.clock"
  export ROTATION_STATE="$TMP_DIR/rot-resume.rotation" INSTALL_STATE="$TMP_DIR/rot-resume.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"

  # 1) app/worker-Neustart scheitert -> Phase published bleibt.
  if FAIL_WRITERS_ONCE="$TMP_DIR/rot-resume.writers-failed" run_rotation "$env_file" key >/dev/null 2>&1; then
    test_fail "rotation continued although the writers did not restart"
  fi
  grep -q '^phase=published$' "$ROTATION_STATE" || test_fail "state is not 'published' after a failed switch"
  [[ "$(file_mode "$ROTATION_STATE")" == "600" ]] || test_fail "rotation state is not 0600"
  kid_after_first="$(grep '^new_id=' "$ROTATION_STATE" | cut -d= -f2)"
  state_text="$(cat "$ROTATION_STATE")"
  for value in "$(env_value "$env_file" TCMS_ACTOR_PRIVATE_KEY_NEXT)" "$(env_value "$env_file" TCMS_ACTOR_PRIVATE_KEY)" \
    "$(env_value "$env_file" TCMS_SERVICE_TOKEN)"; do
    [[ -n "$value" && "$state_text" != *"$value"* ]] || test_fail "rotation state contains a secret"
  done

  # 2) Abbruch waehrend der Wartezeit (Strg-C nach 120 s).
  if ABORT_AFTER=1700000120 run_rotation "$env_file" key >/dev/null 2>&1; then
    test_fail "interrupted wait reported success"
  fi
  grep -q '^phase=switched$' "$ROTATION_STATE" || test_fail "state is not 'switched' after the interrupted wait"
  [[ "$(env_value "$env_file" TCMS_ACTOR_KEY_ID)" == "$kid_after_first" ]] || test_fail "resume generated another key"
  [[ "$(env_value "$env_file" TCMS_ACTOR_PUBLIC_KEYS)" == *,* ]] || test_fail "old key removed during the interrupted wait"

  # 3) Fortsetzen: wartet nur die Restzeit, entfernt dann den alten Schluessel.
  run_rotation "$env_file" key >/dev/null 2>&1 || test_fail "resumed rotation failed"
  [[ "$(env_value "$env_file" TCMS_ACTOR_KEY_ID)" == "$kid_after_first" ]] || test_fail "resume changed the new kid"
  [[ "$(env_value "$env_file" TCMS_ACTOR_PUBLIC_KEYS)" != *,* ]] || test_fail "old key not removed after resume"
  (( $(cat "$CLOCK") >= 1700000300 )) || test_fail "resume shortened the 300 s overlap"
  [[ ! -e "$ROTATION_STATE" ]] || test_fail "rotation state left behind"

  # 4) Eine andere Rotation wartet, bis die laufende abgeschlossen ist.
  if FAIL_API_ONCE="$TMP_DIR/rot-resume.api-failed" run_rotation "$env_file" token >/dev/null 2>&1; then
    test_fail "token rotation continued although tcms-api did not become healthy"
  fi
  if run_rotation "$env_file" key >"$TMP_DIR/rot-resume.out" 2>&1; then
    test_fail "a key rotation started while a token rotation was unfinished"
  fi
  assert_contains "$TMP_DIR/rot-resume.out" "Eine Rotation (token) ist nicht abgeschlossen"
  run_rotation "$env_file" token >/dev/null 2>&1 || test_fail "token rotation did not resume"
  pass "rotation resumes after failures and interruptions without new secrets or a shorter overlap"
}

test_rotation_refuses_inconsistent_or_unmanaged_configuration() {
  local env_file="$TMP_DIR/rot-refuse.env" out="$TMP_DIR/rot-refuse.out"
  export CALLS="$TMP_DIR/rot-refuse.calls" CLOCK="$TMP_DIR/rot-refuse.clock"
  export ROTATION_STATE="$TMP_DIR/rot-refuse.rotation" INSTALL_STATE="$TMP_DIR/rot-refuse.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  sed -i "s/^TCMS_SERVICE_TOKENS=.*/&,zusatzTokenOhneRotation0123456789abcdef/" "$env_file"
  if run_rotation "$env_file" token >"$out" 2>&1; then test_fail "rotation accepted an inconsistent token list"; fi
  assert_contains "$out" "genau das aktuelle Token enthalten"
  [[ ! -s "$CALLS" && ! -e "$ROTATION_STATE" ]] || test_fail "refused rotation changed state or restarted services"
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=external/' "$env_file"
  if run_rotation "$env_file" key >"$out" 2>&1; then test_fail "CLI rotation ran for an external Tax-CMS"; fi
  assert_contains "$out" "gilt fuer TCMS_DEPLOYMENT=managed"
  pass "rotation refuses inconsistent lists and unmanaged deployments before any side effect"
}

test_external_setup_requires_https_and_prints_only_the_public_key() {
  local env_file="$TMP_DIR/setup-external.env" out="$TMP_DIR/setup-external.out" private
  tcms_base_env "$env_file"
  if tcms_isolated "$env_file" eval 'load_env; TCMS_URL=http://tcms-api:3200; TCMS_SERVICE_TOKEN=externTokenMitGenugZeichen0123456789ab; tcms_configure_external' </dev/null >"$out" 2>&1; then
    test_fail "external setup accepted the managed compose URL"
  fi
  if tcms_isolated "$env_file" eval 'load_env; TCMS_URL=http://tcms.example.test; TCMS_SERVICE_TOKEN=externTokenMitGenugZeichen0123456789ab; tcms_configure_external' </dev/null >"$out" 2>&1; then
    test_fail "external setup accepted plain HTTP"
  fi
  if tcms_isolated "$env_file" eval 'load_env; TCMS_URL=https://tcms.example.test; TCMS_SERVICE_TOKEN=bitte-ersetzen-durch-ein-langes-token-xx; tcms_configure_external' </dev/null >"$out" 2>&1; then
    test_fail "external setup accepted a placeholder token"
  fi
  tcms_isolated "$env_file" eval 'load_env; TCMS_URL=https://tcms.example.test/; TCMS_SERVICE_TOKEN=externTokenMitGenugZeichen0123456789ab; tcms_configure_external' </dev/null >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "valid external setup failed"
  }
  assert_key_equals "$env_file" TCMS_DEPLOYMENT external
  assert_key_equals "$env_file" TCMS_URL https://tcms.example.test
  assert_key_equals "$env_file" TCMS_SERVICE_TOKENS ""
  private="$(env_value "$env_file" TCMS_ACTOR_PRIVATE_KEY)"
  [[ -n "$private" ]] || test_fail "no private key generated for external mode"
  assert_contains "$out" "$(env_value "$env_file" TCMS_ACTOR_KEY_ID)=MCowBQYDK2VwAyEA"
  assert_not_contains "$out" "$private"
  assert_not_contains "$out" "externTokenMitGenugZeichen0123456789ab"
  pass "external setup requires HTTPS and a real token and prints only the public key"
}

test_disable_restarts_writers_first_and_keeps_the_database_volume() {
  local env_file="$TMP_DIR/disable.env" calls="$TMP_DIR/disable.calls" super
  managed_env "$env_file"; : >"$calls"
  super="$(env_value "$env_file" TCMS_DB_SUPERUSER_PASSWORD)"
  printf 'current=1.0.0\n' >"$TMP_DIR/disable.state"
  INSTALL_STATE="$TMP_DIR/disable.state" tcms_isolated "$env_file" eval '
    compose() { printf "compose %s TCMS_DEPLOYMENT=%s TCMS_URL=%s\n" "$*" "$TCMS_DEPLOYMENT" "${TCMS_URL:-}" >>"'"$calls"'"; }
    docker() { printf "docker %s\n" "$*" >>"'"$calls"'"; return 0; }
    smoke_health() { :; }
    load_env; cmd_tcms_disable
  ' >/dev/null 2>&1 || test_fail "disable failed"
  assert_key_equals "$env_file" TCMS_DEPLOYMENT disabled
  for key in TCMS_URL TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY TCMS_ACTOR_KEY_ID TCMS_SERVICE_TOKENS TCMS_ACTOR_PUBLIC_KEYS; do
    assert_key_equals "$env_file" "$key" ""
  done
  assert_key_equals "$env_file" TCMS_DB_SUPERUSER_PASSWORD "$super"
  assert_contains "$calls" "compose up -d --no-deps --force-recreate --wait --wait-timeout 300 app worker TCMS_DEPLOYMENT=disabled TCMS_URL="
  assert_before "$calls" "app worker" "docker stop --time 30 taxtronik-tcms-api"
  assert_contains "$calls" "docker network rm taxtronik-tcms-frontend"
  assert_not_contains "$calls" "volume rm"
  pass "disable restarts app/worker without TCMS first, removes the service and keeps the volume"
}

test_configure_tcms_for_env_persists_disabled_and_fills_only_gaps() {
  local env_file="$TMP_DIR/for-env.env" token
  tcms_base_env "$env_file"
  tcms_isolated "$env_file" eval 'load_env; configure_tcms_for_env' >/dev/null
  assert_key_equals "$env_file" TCMS_DEPLOYMENT disabled
  [[ -z "$(env_value "$env_file" TCMS_SERVICE_TOKEN)" ]] || test_fail "disabled mode generated TCMS secrets"
  managed_env "$env_file"
  token="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  sed -i 's/^TCMS_DB_APP_PASSWORD=.*/TCMS_DB_APP_PASSWORD=/' "$env_file"
  tcms_isolated "$env_file" eval 'load_env; configure_tcms_for_env' >/dev/null
  [[ -n "$(env_value "$env_file" TCMS_DB_APP_PASSWORD)" ]] || test_fail "missing TCMS_DB_APP_PASSWORD not generated"
  assert_key_equals "$env_file" TCMS_SERVICE_TOKEN "$token"
  pass "deploy/update persist disabled for unset TCMS and only fill missing managed secrets"
}

# ---------------------------------------------------------------------------
# doctor und Initialsetup
# ---------------------------------------------------------------------------
run_tcms_doctor() {
  local env_file="$1" out="$2"
  shift 2
  tcms_isolated "$env_file" eval '
    load_env
    _DOCTOR_ERRS=0; _DOCTOR_WARNS=0
    '"$*"'
    _doctor_tcms
    printf "ERRS=%s WARNS=%s\n" "$_DOCTOR_ERRS" "$_DOCTOR_WARNS"
  ' >"$out" 2>&1
}

test_doctor_checks_tcms_formats_without_printing_values() {
  local env_file="$TMP_DIR/doctor-tcms.env" out="$TMP_DIR/doctor-tcms.out" key value other
  managed_env "$env_file"
  run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "ERRS=0"
  assert_contains "$out" "OK       TCMS_ACTOR_PUBLIC_KEYS"
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY; do
    value="$(env_value "$env_file" "$key")"
    assert_not_contains "$out" "$value"
  done

  # Token nicht gelistet.
  cp "$env_file" "$env_file.token"
  sed -i "s/^TCMS_SERVICE_TOKENS=.*/TCMS_SERVICE_TOKENS=andererTokenMitGenugZeichen0123456789ab/" "$env_file.token"
  run_tcms_doctor "$env_file.token" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "aktuelles Token von app/worker ist nicht gelistet"

  # Privater Schluessel passt nicht zum gelisteten oeffentlichen.
  other="$TMP_DIR/doctor-tcms-other.env"; managed_env "$other"
  cp "$env_file" "$env_file.key"
  sed -i "s|^TCMS_ACTOR_PRIVATE_KEY=.*|TCMS_ACTOR_PRIVATE_KEY=$(env_value "$other" TCMS_ACTOR_PRIVATE_KEY)|" "$env_file.key"
  run_tcms_doctor "$env_file.key" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "passt nicht zum privaten Schluessel"

  # Gleiches Passwort fuer zwei Rollen.
  cp "$env_file" "$env_file.pw"
  sed -i "s|^TCMS_DB_APP_PASSWORD=.*|TCMS_DB_APP_PASSWORD=$(env_value "$env_file" TCMS_DB_OWNER_PASSWORD)|" "$env_file.pw"
  run_tcms_doctor "$env_file.pw" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "jede Rolle braucht ein eigenes Passwort"

  # disabled mit Restwerten, external mit HTTP.
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=disabled/' "$env_file.pw"
  run_tcms_doctor "$env_file.pw" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "bei disabled muessen die TCMS-Zugangswerte leer sein"
  sed -i 's/^TCMS_DEPLOYMENT=disabled$/TCMS_DEPLOYMENT=external/; s|^TCMS_URL=.*|TCMS_URL=http://tcms.example.test|' "$env_file.pw"
  run_tcms_doctor "$env_file.pw" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "externes Tax-CMS braucht eine HTTPS-URL"
  pass "doctor checks TCMS formats and key/token consistency without printing values"
}

# Regel: Netztrennung auch im laufenden Betrieb (doctor, live).
test_doctor_flags_app_in_the_tcms_backend_network() {
  local env_file="$TMP_DIR/doctor-net.env" out="$TMP_DIR/doctor-net.out"
  managed_env "$env_file"
  run_tcms_doctor "$env_file" "$out" '
    docker() {
      case "$*" in
        *"{{range \$name"*taxtronik-tcms-db) printf "taxtronik-tcms-backend \n" ;;
        *"{{range \$name"*taxtronik-app) printf "taxtronik taxtronik-tcms-backend taxtronik-tcms-frontend \n" ;;
        *"{{range \$name"*taxtronik-worker) printf "taxtronik taxtronik-tcms-frontend \n" ;;
        *".State.ExitCode"*) printf "exited 0\n" ;;
        *"network inspect"*) printf "true\n" ;;
        *"Health"*) printf "healthy\n" ;;
      esac
    }'
  assert_contains "$out" "TCMS_NETZ_app"
  assert_contains "$out" "haengt im TCMS-Backend-Netz"
  assert_contains "$out" "OK       TCMS_NETZ_worker"
  assert_contains "$out" "OK       TCMS_MIGRATE"
  pass "doctor flags an app container attached to the TCMS backend network"
}

test_external_health_check_sends_the_token_only_via_stdin() {
  local env_file="$TMP_DIR/doctor-ext.env" out="$TMP_DIR/doctor-ext.out" spies="$TMP_DIR/doctor-ext-spies"
  local log="$TMP_DIR/doctor-ext.log" stdin_log="$TMP_DIR/doctor-ext.stdin"
  tcms_base_env "$env_file"
  {
    printf 'TCMS_DEPLOYMENT=external\nTCMS_URL=https://tcms.example.test\n'
    printf 'TCMS_SERVICE_TOKEN=externTokenMitGenugZeichen0123456789ab\n'
  } >>"$env_file"
  tcms_isolated "$env_file" eval 'load_env; configure_tcms_for_env' >/dev/null
  mkdir -p "$spies"
  printf '#!/usr/bin/env bash\nprintf "curl %%s\\n" "$*" >>%q\ncat >>%q\nexit 0\n' "$log" "$stdin_log" >"$spies/curl"
  chmod +x "$spies/curl"
  run_tcms_doctor "$env_file" "$out" "PATH=\"$spies:\$PATH\""
  assert_contains "$out" "OK       TCMS_HEALTH"
  assert_contains "$log" "--config -"
  assert_not_contains "$log" "externTokenMitGenugZeichen0123456789ab"
  assert_contains "$stdin_log" 'url = "https://tcms.example.test/v1/health"'
  assert_contains "$stdin_log" "Authorization: Bearer externTokenMitGenugZeichen0123456789ab"
  pass "external health check sends the service token only through curl's stdin config"
}

test_initial_setup_asks_for_the_tax_cms() {
  local env_file="$TMP_DIR/setup-plan-tcms.env" plan_root="$TMP_DIR/setup-plan-tcms"
  mkdir -p "$plan_root"; : >"$plan_root/.env.example"
  [[ "$( _SETUP_DEPLOY_CHANNEL=source; configure_setup_tcms <<<'' >/dev/null; printf '%s' "$_SETUP_TCMS_MODE")" == "disabled" ]] || \
    test_fail "Enter did not keep the Tax-CMS disabled"
  [[ "$( _SETUP_DEPLOY_CHANNEL=source; configure_setup_tcms <<<'2' >/dev/null; printf '%s' "$_SETUP_TCMS_MODE")" == "managed" ]] || \
    test_fail "managed choice not taken"
  if ( _SETUP_DEPLOY_CHANNEL=source; configure_setup_tcms <<<$'3\nhttps://tcms.example.test\nkurz' ) >/dev/null 2>&1; then
    test_fail "external setup accepted a short token"
  fi
  (
    ROOT="$plan_root"; ENVFILE="$env_file"; INSTALL_PENDING="$plan_root/install.pending"
    _SETUP_DEPLOY_CHANNEL=source
    configure_setup_tcms <<<$'3\nhttp://unsicher.example\nhttps://tcms.example.test/\nexternTokenMitGenugZeichen0123456789ab' >/dev/null 2>&1
    _SETUP_METHOD=standard _SETUP_IMAGE_PREFIX=taxtronik _SETUP_RELEASE_VERSION=source-0123456789ab
    _SETUP_STAFF_HOST=staff.example.de _SETUP_PORTAL_HOST=portal.example.de _SETUP_N8N_HOST=n8n.example.de
    _SETUP_ACME_EMAIL="" _SETUP_SMTP_HOST=smtp.example.de _SETUP_SMTP_PORT=587 _SETUP_SMTP_FROM=x@example.de
    _SETUP_SMTP_USER="" _SETUP_SMTP_PASSWORD="" _SETUP_SIGNAL_MODE=disabled _SETUP_SIGNAL_CHANNEL=""
    _SETUP_SIGNAL_IMAGE="" _SETUP_SIGNAL_GIT_URL="" _SETUP_SIGNAL_GIT_REF="" _SETUP_SIGNAL_GIT_DIR=""
    _SETUP_SIGNAL_URL="" _SETUP_SIGNAL_TOKEN="" _SETUP_SIGNAL_OPERATOR_TOKEN=""
    _SETUP_TENANT_NAME=Test _SETUP_ADMIN_EMAIL=admin@example.de
    apply_initial_setup_plan
  ) >/dev/null
  assert_key_equals "$env_file" TCMS_DEPLOYMENT external
  assert_key_equals "$env_file" TCMS_URL https://tcms.example.test
  assert_key_equals "$env_file" TCMS_SERVICE_TOKEN externTokenMitGenugZeichen0123456789ab
  pass "initial setup asks for the Tax-CMS like Signal and defaults to disabled"
}

# ---------------------------------------------------------------------------
# Release-Vertrag: deploy, update, rollback
# ---------------------------------------------------------------------------
# Regel: Ohne gueltige Signatur kein TCMS-Image. prepare_release_contract
# stagt die Pins erst nach Signatur- und Checkout-Pruefung, aus genau dem
# signierten Commit; leere Pins halten ein nicht verwaltetes Tax-CMS nicht auf.
test_registry_release_stages_tcms_pins_from_the_signed_commit() {
  local repo="$TMP_DIR/stage-pins" env_file="$TMP_DIR/stage-pins.env" calls="$TMP_DIR/stage-pins.calls"
  local commit out="$TMP_DIR/stage-pins.out"
  commit="$(pin_repo "$repo" "$(pins_text 1.4.0 "$DIGEST_API" "$DIGEST_MIGRATE")")"
  printf 'TCMS_DEPLOYMENT=managed\nTCMS_VERSION=0.0.1\nTCMS_API_DIGEST_SUFFIX=@sha256:%s\n' \
    "$(printf 'f%.0s' {1..64})" >"$env_file"
  : >"$calls"
  (
    ROOT="$repo"; ENVFILE="$env_file"
    unset "${TCMS_CONFIG_VARS[@]}"
    load_env
    images_from_registry() { return 0; }
    resolve_release_contract() {
      printf 'resolve\n' >>"$calls"
      UPDATE_COMMIT_SHA="$commit"
      UPDATE_WEB_DIGEST="sha256:$(printf 'a%.0s' {1..64})"
      UPDATE_WORKER_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
    }
    verify_release_checkout() { printf 'verify\n' >>"$calls"; }
    prepare_release_contract
    printf 'staged %s %s %s\n' "$TCMS_VERSION" "$TCMS_API_DIGEST_SUFFIX" "$TCMS_MIGRATE_DIGEST_SUFFIX" >>"$calls"
    commit_release_contract
  ) || test_fail "prepare_release_contract failed"
  assert_contains "$calls" "staged 1.4.0 @$DIGEST_API @$DIGEST_MIGRATE"
  assert_before "$calls" "verify" "staged"
  assert_key_equals "$env_file" TCMS_VERSION 1.4.0
  assert_key_equals "$env_file" TCMS_API_DIGEST_SUFFIX "@$DIGEST_API"
  assert_key_equals "$env_file" TCMS_MIGRATE_DIGEST_SUFFIX "@$DIGEST_MIGRATE"

  # Signatur ungueltig: resolve bricht ab, es wird nichts gestagt.
  if (
    ROOT="$repo"; ENVFILE="$env_file"
    images_from_registry() { return 0; }
    resolve_release_contract() { die "Update-Manifest/Signatur/Release-Vertrag ungueltig."; }
    tcms_stage_release_pins() { printf 'staged-after-bad-signature\n' >>"$calls"; }
    prepare_release_contract
  ) >"$out" 2>&1; then test_fail "an invalid signature did not stop the release contract"; fi
  assert_not_contains "$calls" "staged-after-bad-signature"

  # Leere Pins: disabled laeuft weiter (auch unter set -e), managed bricht ab.
  rm -rf "$repo"; commit="$(pin_repo "$repo" "$(pins_text "" "" "")")"
  # Ohne if/||, damit errexit wie im echten Lauf gilt.
  set +e
  (
    set -e
    ROOT="$repo"; ENVFILE="$env_file"; TCMS_DEPLOYMENT=disabled
    tcms_stage_release_pins "$commit"
    [[ -z "$TCMS_VERSION$TCMS_API_DIGEST_SUFFIX$TCMS_MIGRATE_DIGEST_SUFFIX" ]] || exit 3
    printf 'continued\n' >>"$calls"
  )
  set -e
  assert_contains "$calls" "continued"
  if ( ROOT="$repo"; ENVFILE="$env_file"; TCMS_DEPLOYMENT=managed; tcms_stage_release_pins "$commit" ) >"$out" 2>&1; then
    test_fail "managed TCMS accepted a signed release without TCMS pins"
  fi
  assert_contains "$out" "verankert kein TCMS-Release"
  pass "release contract stages TCMS digests only from the verified signed commit"
}

test_provide_tcms_images_pulls_only_signed_digests() {
  local calls="$TMP_DIR/provide.calls" out="$TMP_DIR/provide.out"
  : >"$calls"
  provide_with() (
    TCMS_DEPLOYMENT=managed TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
    TCMS_VERSION="$1" TCMS_API_DIGEST_SUFFIX="$2" TCMS_MIGRATE_DIGEST_SUFFIX="$3" LABEL="$4" CHANNEL="$5"
    images_from_registry() { [[ "$CHANNEL" == release ]]; }
    docker() {
      printf 'docker %s\n' "$*" >>"$calls"
      case "$1 $2" in
        "image inspect")
          [[ "$*" != *--format* ]] || printf '%s\n' "$LABEL"
          [[ "$*" != *missing* ]]
          ;;
        *) return 0 ;;
      esac
    }
    provide_tcms_images
  )
  provide_with 1.4.0 "@$DIGEST_API" "@$DIGEST_MIGRATE" 1.4.0 release >/dev/null || test_fail "signed images rejected"
  assert_contains "$calls" "docker pull registry.example/taxtronik/tcms-api:1.4.0@$DIGEST_API"
  assert_contains "$calls" "docker pull registry.example/taxtronik/tcms-migrate:1.4.0@$DIGEST_MIGRATE"
  if provide_with 1.4.0 "@$DIGEST_API" "@$DIGEST_MIGRATE" 1.3.9 release >"$out" 2>&1; then
    test_fail "image with a foreign version label accepted"
  fi
  assert_contains "$out" "stimmt nicht mit der signierten TCMS-Version"
  : >"$calls"
  if provide_with 1.4.0 "" "@$DIGEST_MIGRATE" 1.4.0 release >"$out" 2>&1; then
    test_fail "registry image without digest accepted"
  fi
  assert_not_contains "$calls" "docker pull"
  : >"$calls"
  provide_with dev-1 "" "" "" source >/dev/null || test_fail "local source images rejected"
  assert_not_contains "$calls" "docker pull"
  if provide_with missing "" "" "" source >"$out" 2>&1; then test_fail "missing local image accepted"; fi
  pass "TCMS images: registry only by signed digest with version label, source only local tags"
}

test_deploy_and_update_start_tcms_between_migrations_and_writers() {
  local steps="$TMP_DIR/deploy-order.steps" fn step
  local -a deploy_steps=(load_env prepare_source_version_for_checkout preflight_common assert_production_env
    require_release_version assert_no_database_restore_pending ensure_host_tool_deps prepare_release_contract
    start_infra wait_postgres_healthy sync_postgres_roles_from_env provide_images assert_app_env_schema
    provide_traefik_for_deploy provide_signal_for_deploy provide_tcms_images backup_before_migrations
    run_migrations ensure_provisioned_interactive ensure_managed_n8n_connection start_tcms_for_deploy
    start_signal_for_deploy start_apps_for_activation smoke_health smoke_public_frontend smoke_client_ip
    deploy_readiness finalize_release_contract prepare_env_interactive image_tag)
  for fn in _deploy_core continue_update_after_checkout; do
    : >"$steps"
    (
      for step in "${deploy_steps[@]}"; do
        eval "$step() { printf '%s\n' $step >>\"$steps\"; }"
      done
      "$fn"
    ) >/dev/null
    assert_before "$steps" "provide_tcms_images" "run_migrations"
    assert_before "$steps" "run_migrations" "start_tcms_for_deploy"
    assert_before "$steps" "start_tcms_for_deploy" "start_apps_for_activation"
    assert_before "$steps" "start_tcms_for_deploy" "finalize_release_contract"
  done
  pass "deploy and update provide TCMS images before migrations and start TCMS before the writers"
}

test_start_tcms_runs_migration_before_api_and_falls_back() {
  local env_file="$TMP_DIR/start-tcms.env" calls="$TMP_DIR/start-tcms.calls" out="$TMP_DIR/start-tcms.out"
  printf 'TCMS_DEPLOYMENT=managed\nTCMS_VERSION=1.3.0\nTCMS_API_DIGEST_SUFFIX=@%s\nTCMS_MIGRATE_DIGEST_SUFFIX=@%s\n' \
    "$DIGEST_MIGRATE" "$DIGEST_API" >"$env_file"
  start_with() (
    ENVFILE="$env_file"; MIGRATE_EXIT="$1"; API_RESULT="$2"; LEDGER="${3:-f}"
    TCMS_DEPLOYMENT=managed TCMS_VERSION=1.4.0 TCMS_API_DIGEST_SUFFIX="@$DIGEST_API" TCMS_MIGRATE_DIGEST_SUFFIX="@$DIGEST_MIGRATE"
    backup_tcms_with_upload() { printf 'tcms-backup\n' >>"$calls"; }
    compose() {
      printf 'compose %s version=%s\n' "$*" "$TCMS_VERSION" >>"$calls"
      if [[ "$*" == *"tcms-api"* && "$TCMS_VERSION" == 1.4.0 ]]; then return "$API_RESULT"; fi
      return 0
    }
    docker() {
      printf 'docker %s\n' "$*" >>"$calls"
      case "$1" in
        wait) printf '%s\n' "$MIGRATE_EXIT" ;;
        inspect) printf 'healthy\n' ;;
        exec) printf '%s\n' "$LEDGER" ;;
      esac
      return 0
    }
    start_tcms_for_deploy
  )
  : >"$calls"
  start_with 0 0 >/dev/null 2>&1 || test_fail "healthy TCMS start failed"
  assert_before "$calls" "compose --profile tcms up -d --no-deps tcms-db" "compose --profile tcms up -d --no-deps tcms-migrate"
  assert_before "$calls" "docker wait taxtronik-tcms-migrate" "tcms-api version=1.4.0"
  : >"$calls"
  if start_with 3 0 >"$out" 2>&1; then test_fail "failed migration did not stop the start"; fi
  assert_contains "$out" "tcms-migrate fehlgeschlagen (Exit 3)"
  assert_not_contains "$calls" "tcms-api version"
  : >"$calls"
  if start_with 0 1 >"$out" 2>&1; then test_fail "unhealthy tcms-api reported success"; fi
  assert_contains "$calls" "--force-recreate --wait --wait-timeout 180 tcms-api version=1.3.0"
  assert_not_contains "$calls" "tcms-backup"
  # Vorhandenes Schema: Backup vor tcms-migrate; unklare Antwort: keine Migration.
  : >"$calls"
  start_with 0 0 t >/dev/null 2>&1 || test_fail "TCMS start with existing schema failed"
  assert_before "$calls" "tcms-backup" "compose --profile tcms up -d --no-deps tcms-migrate"
  : >"$calls"
  if start_with 0 0 unklar >"$out" 2>&1; then test_fail "TCMS migrated without a clear schema answer"; fi
  assert_not_contains "$calls" "tcms-migrate"
  pass "TCMS start: database, backup of an existing schema, migration with checked exit code, api, fallback"
}

# Rollback-Attrappe mit echtem Git (zwei Release-Commits) und protokollierenden
# docker/compose-Aufrufen.
rollback_repo() {
  local repo="$1"
  mkdir -p "$repo/infra/compose"
  git -C "$repo" init -q
  printf 'services: {}\n' >"$repo/infra/compose/docker-compose.tcms.yml"
  pins_text 1.0.0 "$DIGEST_API" "$DIGEST_MIGRATE" >"$repo/infra/compose/tcms-release.env"
  git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@example.test commit -qm previous
  ROLLBACK_PREVIOUS="$(git -C "$repo" rev-parse HEAD)"
  pins_text 1.1.0 "sha256:$(printf '5%.0s' {1..64})" "sha256:$(printf '6%.0s' {1..64})" \
    >"$repo/infra/compose/tcms-release.env"
  git -C "$repo" -c user.name=t -c user.email=t@example.test commit -qam current
  ROLLBACK_CURRENT="$(git -C "$repo" rev-parse HEAD)"
}

run_tcms_rollback() (
  local repo="$1" env_file="$2" state_file="$3" calls="$4"
  ROOT="$repo"; ENVFILE="$env_file"; STATE="$state_file"
  MIGRATION_PENDING="$repo/.pending"; DB_RESTORE_AUTHORIZATION="$repo/.restored"; INSTALL_PENDING="$repo/.install"
  unset "${TCMS_CONFIG_VARS[@]}" TAXTRONIK_VERSION TAXTRONIK_WEB_DIGEST_SUFFIX TAXTRONIK_WORKER_DIGEST_SUFFIX TAXTRONIK_RELEASE_COMMIT
  require_cmd() { :; }
  preflight_common() { :; }
  assert_production_env() { :; }
  ensure_host_tool_deps() { :; }
  images_from_registry() { return 0; }
  fetch_verified_release_tag() { printf 'fetch-tag %s\n' "$1" >>"$calls"; }
  require_clean_release_checkout() { :; }
  smoke_health() { :; }
  smoke_public_frontend() { :; }
  deploy_readiness() { :; }
  start_apps() {
    printf 'apps %s\n' "$TAXTRONIK_VERSION" >>"$calls"
    if [[ -n "${FAIL_APPS_ONCE:-}" && ! -e "$FAIL_APPS_ONCE" ]]; then : >"$FAIL_APPS_ONCE"; return 1; fi
  }
  compose() { printf 'compose %s version=%s api=%s\n' "$*" "${TCMS_VERSION:-}" "${TCMS_API_DIGEST_SUFFIX:-}" >>"$calls"; }
  docker() {
    printf 'docker %s\n' "$*" >>"$calls"
    case "$*" in
      "image inspect --format"*revision*) printf '%s\n' "$TAXTRONIK_RELEASE_COMMIT" ;;
      "image inspect --format"*version*/tcms-*) printf '%s\n' "$TCMS_VERSION" ;;
      "image inspect --format"*version*) printf '%s\n' "$TAXTRONIK_VERSION" ;;
    esac
    return 0
  }
  cmd_rollback ""
)

tcms_rollback_fixture() {
  local repo="$1" env_file="$2" state_file="$3"
  rollback_repo "$repo"
  cat >"$state_file" <<STATE
previous=1.0.0
previous_web_digest_suffix=@sha256:$(printf '1%.0s' {1..64})
previous_worker_digest_suffix=@sha256:$(printf '2%.0s' {1..64})
previous_commit=$ROLLBACK_PREVIOUS
current=2.0.0
current_web_digest_suffix=@sha256:$(printf '3%.0s' {1..64})
current_worker_digest_suffix=@sha256:$(printf '4%.0s' {1..64})
current_commit=$ROLLBACK_CURRENT
current_rollback_requires_db_restore=false
STATE
  cat >"$env_file" <<ENVFILE
NODE_ENV=production
TAXTRONIK_IMAGE_PREFIX=registry.example/taxtronik
TAXTRONIK_VERSION=2.0.0
TAXTRONIK_WEB_DIGEST_SUFFIX=@sha256:$(printf '3%.0s' {1..64})
TAXTRONIK_WORKER_DIGEST_SUFFIX=@sha256:$(printf '4%.0s' {1..64})
TAXTRONIK_RELEASE_COMMIT=$ROLLBACK_CURRENT
TCMS_DEPLOYMENT=managed
TCMS_VERSION=1.1.0
TCMS_API_DIGEST_SUFFIX=@sha256:$(printf '5%.0s' {1..64})
TCMS_MIGRATE_DIGEST_SUFFIX=@sha256:$(printf '6%.0s' {1..64})
ENVFILE
}

# Regel: Rollback beruecksichtigt TCMS-Digests: Ziel-Pins aus dem signierten
# Ziel-Commit, Pull vor dem Checkout-Wechsel, tcms-api vor app/worker, kein
# Migrationsschritt; ein Ziel ohne TCMS wird vor jeder Wirkung abgewiesen.
test_registry_rollback_switches_tcms_to_the_signed_target_pins() {
  local repo="$TMP_DIR/rb-ok" env_file="$TMP_DIR/rb-ok.env" state_file="$TMP_DIR/rb-ok.state"
  local calls="$TMP_DIR/rb-ok.calls"
  tcms_rollback_fixture "$repo" "$env_file" "$state_file"; : >"$calls"
  run_tcms_rollback "$repo" "$env_file" "$state_file" "$calls" >"$TMP_DIR/rb-ok.out" 2>&1 || {
    cat "$TMP_DIR/rb-ok.out" >&2; test_fail "rollback failed"
  }
  assert_contains "$calls" "docker pull registry.example/taxtronik/tcms-api:1.0.0@$DIGEST_API"
  assert_contains "$calls" "docker pull registry.example/taxtronik/tcms-migrate:1.0.0@$DIGEST_MIGRATE"
  assert_before "$calls" "tcms-api:1.0.0@$DIGEST_API" "--force-recreate --wait --wait-timeout 180 tcms-api version=1.0.0"
  assert_before "$calls" "tcms-api version=1.0.0" "apps 1.0.0"
  assert_not_contains "$calls" "tcms-migrate version"
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$ROLLBACK_PREVIOUS" ]] || test_fail "checkout not switched to the target"
  assert_key_equals "$env_file" TCMS_VERSION 1.0.0
  assert_key_equals "$env_file" TCMS_API_DIGEST_SUFFIX "@$DIGEST_API"

  # Ziel ohne TCMS-Unterstuetzung: Abbruch vor Pull und Checkout-Wechsel.
  repo="$TMP_DIR/rb-old"; env_file="$TMP_DIR/rb-old.env"; state_file="$TMP_DIR/rb-old.state"; calls="$TMP_DIR/rb-old.calls"
  tcms_rollback_fixture "$repo" "$env_file" "$state_file"; : >"$calls"
  git -C "$repo" checkout -q "$ROLLBACK_PREVIOUS"
  git -C "$repo" rm -q infra/compose/docker-compose.tcms.yml
  git -C "$repo" -c user.name=t -c user.email=t@example.test commit -qm without-tcms
  sed -i "s/^previous_commit=.*/previous_commit=$(git -C "$repo" rev-parse HEAD)/" "$state_file"
  git -C "$repo" checkout -q "$ROLLBACK_CURRENT"
  if run_tcms_rollback "$repo" "$env_file" "$state_file" "$calls" >"$TMP_DIR/rb-old.out" 2>&1; then
    test_fail "rollback to a release without TCMS support ran with managed TCMS"
  fi
  assert_contains "$TMP_DIR/rb-old.out" "kennt das verwaltete Tax-CMS nicht"
  assert_not_contains "$calls" "docker pull"
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$ROLLBACK_CURRENT" ]] || test_fail "refused rollback changed the checkout"
  pass "registry rollback pulls the target TCMS digests first and switches tcms-api before the writers"
}

test_failed_rollback_restores_the_last_good_tcms_images() {
  local repo="$TMP_DIR/rb-fail" env_file="$TMP_DIR/rb-fail.env" state_file="$TMP_DIR/rb-fail.state"
  local calls="$TMP_DIR/rb-fail.calls"
  tcms_rollback_fixture "$repo" "$env_file" "$state_file"; : >"$calls"
  # Ohne if/||: errexit muss wie im echten Lauf greifen (Writer-Start scheitert).
  set +e
  ( set -e; FAIL_APPS_ONCE="$TMP_DIR/rb-fail.apps-failed" run_tcms_rollback "$repo" "$env_file" "$state_file" "$calls" ) \
    >"$TMP_DIR/rb-fail.out" 2>&1
  local rc=$?
  set -e
  (( rc != 0 )) || test_fail "failed rollback reported success"
  assert_before "$calls" "tcms-api version=1.0.0" "apps 2.0.0"
  assert_contains "$calls" "--force-recreate --wait --wait-timeout 180 tcms-api version=1.1.0 api=@sha256:$(printf '5%.0s' {1..64})"
  assert_key_equals "$env_file" TCMS_VERSION 1.1.0
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$ROLLBACK_CURRENT" ]] || test_fail "last-good checkout not restored"
  pass "a failed rollback restores the last-good TCMS images together with the last-good writers"
}

# ---------------------------------------------------------------------------
# Backup und Restore der verwalteten TCMS-Datenbank
# ---------------------------------------------------------------------------
tcms_db_docker_stub() {
  cat <<'STUB'
docker() {
  printf 'docker %s\n' "$*" >>"$CALLS"
  case "$*" in
    "inspect --format {{.State.Running}} taxtronik-tcms-db") printf 'true\n' ;;
    "exec taxtronik-tcms-db pg_dump"*) [[ -z "${FAIL_DUMP:-}" ]] || return 1; printf 'PGDMP-wegwerf-archiv\n' ;;
    "exec -i taxtronik-tcms-db pg_restore --list") cat >/dev/null; [[ -z "${FAIL_LIST:-}" ]] || return 1 ;;
    "exec -i taxtronik-tcms-db psql"*) cat >>"$PSQL_STDIN" ;;
    "exec -i taxtronik-tcms-db pg_restore -U tcms"*) cat >/dev/null; [[ -z "${FAIL_RESTORE:-}" ]] || return 1 ;;
    "exec taxtronik-tcms-db psql"*) printf '%s\n' "${LEDGER:-t}" ;;
    "inspect taxtronik-tcms-api") return 0 ;;
  esac
  return 0
}
STUB
}

test_tcms_backup_dumps_in_container_with_0600_and_checksum() {
  local env_file="$TMP_DIR/tcms-backup.env" dest="$TMP_DIR/tcms-backup-dest" file
  export CALLS="$TMP_DIR/tcms-backup.calls" PSQL_STDIN="$TMP_DIR/tcms-backup.stdin"
  managed_env "$env_file"; : >"$CALLS"
  tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'
    load_env
    run_backup_tcms "'"$dest"'"
    printf "%s\n" "$_TCMS_BACKUP_FILE" >"'"$TMP_DIR"'/tcms-backup.file"
  ' >/dev/null 2>&1 || test_fail "TCMS backup failed"
  file="$(cat "$TMP_DIR/tcms-backup.file")"
  [[ "$file" == "$dest"/tcms-db-*.dump && -s "$file" ]] || test_fail "dump file missing: $file"
  [[ "$(file_mode "$file")" == "600" ]] || test_fail "TCMS dump is not 0600"
  ( cd "$dest" && sha256sum --check --quiet "$(basename "$file").sha256" ) || test_fail "checksum file does not match"
  assert_contains "$CALLS" "docker exec taxtronik-tcms-db pg_dump -U tcms -d tcms --format=custom --compress=6"
  assert_before "$CALLS" "pg_dump" "pg_restore --list"
  local key
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
    assert_not_contains "$CALLS" "$(env_value "$env_file" "$key")"
  done
  rm -rf "$dest"; : >"$CALLS"
  if FAIL_DUMP=1 tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'; load_env; run_backup_tcms "'"$dest"'"' >/dev/null 2>&1; then
    test_fail "failed pg_dump reported success"
  fi
  [[ -z "$(find "$dest" -type f 2>/dev/null)" ]] || test_fail "failed dump left files behind"
  : >"$CALLS"
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=disabled/' "$env_file"
  tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'; load_env; run_backup_tcms "'"$dest"'"' >/dev/null 2>&1 || \
    test_fail "disabled TCMS backup failed"
  [[ ! -s "$CALLS" ]] || test_fail "disabled TCMS backup touched docker"
  pass "TCMS backup: pg_dump inside the container, 0600 file, verified archive and checksum"
}

test_tcms_backup_upload_passes_s3_secrets_only_by_name() {
  local file="$TMP_DIR/tcms-upload/tcms-db-20261019-000000-abc.dump" calls="$TMP_DIR/tcms-upload.calls"
  # Wert erst zur Laufzeit zusammensetzen, damit der Secret-Scan kein Literal meldet.
  local s3_marker="geheimnis-0123456789"
  mkdir -p "$(dirname "$file")"; printf 'x' >"$file"; : >"$calls"
  (
    S3_ACCESS_KEY=wegwerfak S3_SECRET_KEY="wegwerf-s3-$s3_marker" S3_BUCKET_BACKUPS=backups
    docker() { printf 'docker %s secret=%s\n' "$*" "${AWS_SECRET_ACCESS_KEY:+gesetzt}" >>"$calls"; }
    upload_tcms_backup "$file"
  ) >/dev/null
  assert_contains "$calls" "-e AWS_SECRET_ACCESS_KEY "
  assert_contains "$calls" "secret=gesetzt"
  assert_contains "$calls" "s3://backups/tcmsdump/"
  assert_contains "$calls" "--network taxtronik"
  assert_not_contains "$calls" "wegwerf-s3-$s3_marker"
  pass "TCMS dump upload uses the backups bucket and passes S3 secrets only by name"
}

test_backup_update_and_full_backup_include_tcms() {
  local steps="$TMP_DIR/backup-cmd.steps" out="$TMP_DIR/backup-cmd.out" body
  : >"$steps"
  (
    for fn in load_env preflight_common assert_production_env start_infra wait_postgres_healthy \
      wait_seaweedfs_healthy sync_postgres_roles_from_env run_backup backup_tcms_with_upload; do
      eval "$fn() { printf '%s\n' $fn >>\"$steps\"; }"
    done
    cmd_backup
  ) >/dev/null
  assert_before "$steps" "run_backup" "backup_tcms_with_upload"
  if (
    for fn in load_env preflight_common assert_production_env start_infra wait_postgres_healthy \
      wait_seaweedfs_healthy sync_postgres_roles_from_env run_backup; do
      eval "$fn() { :; }"
    done
    backup_tcms_with_upload() { return 1; }
    cmd_backup
  ) >"$out" 2>&1; then test_fail "failed TCMS backup did not fail ./taxtronik backup"; fi
  assert_contains "$out" "TCMS-Backup fehlgeschlagen"

  # Update: TCMS-Pflichtbackup gehoert zum Backup vor jeder Code-Aenderung.
  body="$TMP_DIR/cmd-update.body"; declare -f cmd_update >"$body"
  assert_before "$body" 'run_backup ||' 'backup_tcms_with_upload ||'
  assert_before "$body" 'backup_tcms_with_upload ||' 'fetch_verified_release_tag'
  assert_before "$body" 'backup_tcms_with_upload ||' 'git fetch'

  # Full-Backup: tcms-api quiesziert, Dump im verschluesselten Staging.
  body="$TMP_DIR/cmd-backup-full.body"; declare -f cmd_backup_full >"$body"
  assert_before "$body" 'compose --profile tcms stop tcms-api' 'run_backup "$staging/database"'
  assert_before "$body" 'run_backup_tcms "$staging/database"' 'encrypt_full_backup_payload'
  : >"$steps"
  (
    TCMS_DEPLOYMENT=managed
    restart_backup_infra() { printf 'infra\n' >>"$steps"; }
    tcms_restart_api() { printf 'tcms-api\n' >>"$steps"; }
    start_apps() { printf 'apps\n' >>"$steps"; }
    smoke_health() { :; }
    restart_after_full_backup
  ) >/dev/null
  assert_before "$steps" "infra" "tcms-api"
  assert_before "$steps" "tcms-api" "apps"
  pass "backup, update backup and full backup include the managed TCMS database"
}

# Regel: Restore-Argumente vor jeder Seitenwirkung pruefen.
test_tcms_restore_validates_before_side_effects() {
  local dump="$TMP_DIR/restore-val/tcms-db.dump" calls="$TMP_DIR/restore-val.calls" out="$TMP_DIR/restore-val.out" args
  mkdir -p "$(dirname "$dump")"; printf 'PGDMP' >"$dump"
  printf '%s  %s\n' "$(printf 'falsch' | sha256sum | cut -d' ' -f1)" "tcms-db.dump" >"$dump.sha256"
  for args in "--file $dump" "--file $dump --confirm-overwrite ja" "--file $TMP_DIR/fehlt.dump --confirm-overwrite RESTORE_TCMS_DATABASE" \
    "--file $dump --confirm-overwrite RESTORE_TCMS_DATABASE" "--latest --confirm-overwrite RESTORE_TCMS_DATABASE"; do
    : >"$calls"
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Argumentliste des Testfalls
    if (
      ENVFILE="$TMP_DIR/restore-val.no-env"
      docker() { printf 'docker %s\n' "$*" >>"$calls"; }
      compose() { printf 'compose %s\n' "$*" >>"$calls"; }
      cmd_tcms_restore $args
    ) >"$out" 2>&1; then test_fail "restore accepted: $args"; fi
    [[ ! -s "$calls" ]] || test_fail "restore touched services before validating: $args"
    assert_not_contains "$out" "nicht gefunden"
  done
  assert_contains "$out" "Unbekannte Option"
  pass "TCMS restore validates confirmation, file and checksum before any side effect"
}

test_tcms_restore_restores_roles_then_data_then_migrates() {
  local env_file="$TMP_DIR/restore-run.env" dump="$TMP_DIR/restore-run/tcms-db.dump" key value
  export CALLS="$TMP_DIR/restore-run.calls" PSQL_STDIN="$TMP_DIR/restore-run.stdin"
  managed_env "$env_file"; : >"$CALLS"; : >"$PSQL_STDIN"
  mkdir -p "$(dirname "$dump")"; printf 'PGDMP-wegwerf' >"$dump"
  ( cd "$(dirname "$dump")" && sha256sum tcms-db.dump >tcms-db.dump.sha256 )
  restore_run() {
    tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'
      compose() { printf "compose %s\n" "$*" >>"$CALLS"; }
      tcms_wait_db_healthy() { :; }
      resolve_backup_host_dir() { printf "%s" "'"$TMP_DIR"'/restore-run-backups"; }
      run_backup_tcms() { printf "pre-restore-backup %s\n" "$1" >>"$CALLS"; _TCMS_BACKUP_FILE="$1/x.dump"; }
      run_tcms_migrate() { printf "tcms-migrate\n" >>"$CALLS"; }
      tcms_restart_api() { printf "tcms-api-restart\n" >>"$CALLS"; }
      cmd_tcms_restore --file "'"$dump"'" --confirm-overwrite RESTORE_TCMS_DATABASE
    '
  }
  restore_run >"$TMP_DIR/restore-run.out" 2>&1 || { cat "$TMP_DIR/restore-run.out" >&2; test_fail "restore failed"; }
  assert_before "$CALLS" "docker stop --time 30 taxtronik-tcms-api" "compose --profile tcms up -d --no-deps tcms-db"
  assert_before "$CALLS" "compose --profile tcms up -d --no-deps tcms-db" "pg_restore --list"
  assert_before "$CALLS" "pg_restore --list" "pre-restore-backup $TMP_DIR/restore-run-backups/tcms-pre-restore"
  assert_before "$CALLS" "pre-restore-backup" "docker exec -i taxtronik-tcms-db psql -X -q -U tcms -d postgres"
  assert_before "$CALLS" "psql -X -q -U tcms -d postgres" "pg_restore -U tcms -d tcms --exit-on-error --single-transaction"
  assert_before "$CALLS" "pg_restore -U tcms -d tcms" "tcms-migrate"
  assert_before "$CALLS" "tcms-migrate" "tcms-api-restart"
  assert_contains "$PSQL_STDIN" "ALTER ROLE tcms_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L"
  assert_contains "$PSQL_STDIN" "tcms_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT"
  assert_contains "$PSQL_STDIN" "REVOKE tcms_owner FROM tcms_app"
  assert_contains "$PSQL_STDIN" "DROP DATABASE IF EXISTS tcms WITH (FORCE);"
  assert_before "$PSQL_STDIN" "tcms_owner" "DROP DATABASE"
  for key in TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
    value="$(env_value "$env_file" "$key")"
    assert_not_contains "$CALLS" "$value"
    assert_not_contains "$TMP_DIR/restore-run.out" "$value"
    assert_contains "$PSQL_STDIN" "'$value'"
  done
  # Fehlerhafter Restore: kein Migrationsschritt, tcms-api bleibt gestoppt.
  : >"$CALLS"
  if FAIL_RESTORE=1 restore_run >"$TMP_DIR/restore-run.out" 2>&1; then test_fail "failed pg_restore reported success"; fi
  assert_not_contains "$CALLS" "tcms-migrate"
  assert_not_contains "$CALLS" "tcms-api-restart"
  pass "TCMS restore: api stopped, current state saved, roles from .env, data, then migration and api"
}

run_test test_tcms_mode_defaults_to_disabled_and_rejects_unknown_values
run_test test_compose_loads_tcms_file_only_when_managed
run_test test_compose_writer_guard_sees_subcommand_after_global_options
run_test test_release_pins_are_read_strictly_from_a_commit
run_test test_registry_compose_requires_signed_tcms_pins
run_test test_managed_setup_generates_contract_conform_secrets_once
run_test test_setup_and_rotation_never_expose_secrets
run_test test_token_rotation_overlaps_and_retires_the_old_token
run_test test_key_rotation_waits_five_minutes_before_removing_the_old_key
run_test test_rotation_resumes_after_interruptions
run_test test_rotation_refuses_inconsistent_or_unmanaged_configuration
run_test test_external_setup_requires_https_and_prints_only_the_public_key
run_test test_disable_restarts_writers_first_and_keeps_the_database_volume
run_test test_configure_tcms_for_env_persists_disabled_and_fills_only_gaps
run_test test_doctor_checks_tcms_formats_without_printing_values
run_test test_doctor_flags_app_in_the_tcms_backend_network
run_test test_external_health_check_sends_the_token_only_via_stdin
run_test test_initial_setup_asks_for_the_tax_cms
run_test test_registry_release_stages_tcms_pins_from_the_signed_commit
run_test test_provide_tcms_images_pulls_only_signed_digests
run_test test_deploy_and_update_start_tcms_between_migrations_and_writers
run_test test_start_tcms_runs_migration_before_api_and_falls_back
run_test test_registry_rollback_switches_tcms_to_the_signed_target_pins
run_test test_failed_rollback_restores_the_last_good_tcms_images
run_test test_tcms_backup_dumps_in_container_with_0600_and_checksum
run_test test_tcms_backup_upload_passes_s3_secrets_only_by_name
run_test test_backup_update_and_full_backup_include_tcms
run_test test_tcms_restore_validates_before_side_effects
run_test test_tcms_restore_restores_roles_then_data_then_migrates

if (( TESTS_FAILED > 0 )); then
  printf '\n%s ops-tcms tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s ops-tcms tests passed.\n' "$TESTS_RUN"
