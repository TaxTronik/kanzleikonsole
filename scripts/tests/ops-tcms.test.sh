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

if (( TESTS_FAILED > 0 )); then
  printf '\n%s ops-tcms tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s ops-tcms tests passed.\n' "$TESTS_RUN"
