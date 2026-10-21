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

# Geheimnisse erscheinen auch in Fehlermeldungen nur als Kennung, obwohl die
# Tests Wegwerfwerte nutzen (Regel: keine Werte in Ausgaben).
redacted() {
  if [[ -z "${1:-}" ]]; then printf '<leer>'
  else printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -c1-12)"; fi
}

# Wie assert_not_contains, aber ohne den Wert oder die Datei auszugeben; der
# Wert geht per Prozesssubstitution an grep, nicht als Argument.
assert_no_secret() {
  local file="$1" secret="$2" label="${3:-Geheimnis}"
  [[ -n "$secret" ]] || test_fail "assert_no_secret: leerer Wert ($label)"
  if [[ -f "$file" ]] && grep -Fq -f <(printf '%s\n' "$secret") -- "$file"; then
    test_fail "$label $(redacted "$secret") erscheint in $(basename "$file")"
  fi
}

assert_key_equals() {
  local file="$1" key="$2" expected="$3" actual
  actual="$(grep -E "^${key}=" "$file" | head -n1 | cut -d= -f2- || true)"
  [[ "$actual" == "$expected" ]] && return 0
  if [[ "$key" =~ (PASSWORD|TOKEN|PRIVATE|SCHLUESSEL|SECRET) ]]; then
    test_fail "expected ${key}=$(redacted "$expected"), got $(redacted "$actual")"
  fi
  test_fail "expected ${key}=${expected}, got ${actual}"
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

  # Die Operator-CLI startet Tax-CMS und Signal zwischen Migration und
  # Writer-Aktivierung, also bei bestehendem Marker. Das bleibt erlaubt; jeder
  # Aufruf mit einem Writer oder ohne Dienstliste bleibt blockiert.
  for args in "--profile tcms up -d --no-deps tcms-db" \
    "--profile tcms up -d --no-deps --force-recreate --wait --wait-timeout 180 tcms-api" \
    "--profile risk-layer up -d --force-recreate --no-deps --wait --wait-timeout 300 risk-layer"; do
    : >"$calls"
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Argumentliste des Testfalls
    (
      MIGRATION_PENDING="$pending"
      DB_RESTORE_AUTHORIZATION="$TMP_DIR/guard-profile.no-restore"
      render_s3_config() { :; }
      ensure_compose_image_pinning() { :; }
      reconcile_n8n_encryption_key_from_volume() { :; }
      docker() { printf '%s\n' "$*" >>"$calls"; }
      compose $args
    ) >"$out" 2>&1 || { cat "$out" >&2; test_fail "compose $args was blocked although it starts no writer"; }
    [[ -s "$calls" ]] || test_fail "compose $args did not reach docker"
  done
  for args in "--profile tcms up -d tcms-api app" "up -d" "--profile tcms up -d --wait-timeout 60 n8n"; do
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Argumentliste des Testfalls
    compose_starts_writers $args || test_fail "compose $args was not treated as a writer start"
  done
  pass "compose writer guard applies after global options and spares only TCMS/Signal starts"
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
  TCMS_MIGRATE_DIGEST_SUFFIX TCMS_SERVICE_TOKEN_NEXT TCMS_ACTOR_PRIVATE_KEY_NEXT TCMS_ACTOR_KEY_ID_NEXT
  TCMS_CODE_SCHLUESSEL)
tcms_isolated() {
  local env_file="$1"
  shift
  (
    unset "${TCMS_CONFIG_VARS[@]}"
    TCMS_ROTATION_STATE="${ROTATION_STATE:-$TMP_DIR/no-rotation}"
    TCMS_CODE_KEY_ROTATION_STATE="${CODE_ROTATION_STATE:-$TMP_DIR/no-code-rotation}"
    ENVFILE="$env_file"
    STATE="${INSTALL_STATE:-$TMP_DIR/no-install-state}"
    # kk-tcms-s11: nie die echte crontab, der echte Stempel oder backups/ des Checkouts.
    TCMS_BACKUP_STAMP="${BACKUP_STAMP:-$TMP_DIR/no-backup-stamp}"
    export BACKUP_HOST_DIR="${BACKUP_HOST_DIR:-$TMP_DIR/backups-host}"
    eval "$(fake_crontab_stubs)"
    "$@"
  )
}

# Attrappe der crontab des Benutzers: eine Datei (FAKE_CRONTAB); KEIN_CRONTAB=1
# simuliert ein fehlendes crontab-Programm.
fake_crontab_stubs() {
  cat <<'STUB'
tcms_crontab_available() { [[ -z "${KEIN_CRONTAB:-}" ]]; }
tcms_crontab() {
  local datei="${FAKE_CRONTAB:-$TMP_DIR/crontab.default}"
  case "${1:-}" in
    -l) [[ -f "$datei" ]] || { printf 'no crontab for test\n' >&2; return 1; }; cat "$datei" ;;
    -r) rm -f -- "$datei" ;;
    -) cat >"$datei" ;;
    *) return 2 ;;
  esac
}
STUB
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

# TCMS s8 (H5): genau ein Code-Schluessel aus 32 Zufallsbyte (base64url ohne
# Padding), von Token und Passwoertern verschieden. Der Wert geht nur ueber
# die Umgebung an node, nie als Argument.
assert_code_key_format() {
  local env_file="$1" key value
  value="$(env_value "$env_file" TCMS_CODE_SCHLUESSEL)"
  [[ "$value" =~ ^[A-Za-z0-9_-]{43}$ ]] || test_fail "TCMS_CODE_SCHLUESSEL is not one 43-character base64url entry"
  TCMS_CK="$value" "$NODE_BIN" -e '
    const b = Buffer.from(process.env.TCMS_CK, "base64url");
    if (b.length !== 32 || b.toString("base64url") !== process.env.TCMS_CK) process.exit(1);
  ' || test_fail "TCMS_CODE_SCHLUESSEL does not encode exactly 32 random bytes"
  for key in TCMS_SERVICE_TOKEN TCMS_SERVICE_TOKENS TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD; do
    [[ "$value" != "$(env_value "$env_file" "$key")" ]] || test_fail "TCMS_CODE_SCHLUESSEL equals $key"
  done
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
  assert_code_key_format "$env_file"
  [[ "$(file_mode "$env_file")" == "600" ]] || test_fail ".env is not 0600 after setup"
  before="$(cat "$env_file")"
  tcms_isolated "$env_file" eval 'load_env; tcms_configure_managed' >/dev/null
  after="$(cat "$env_file")"
  [[ "$before" == "$after" ]] || test_fail "a second setup rotated existing TCMS secrets"
  pass "managed setup creates contract-conform secrets once and keeps them afterwards"
}

# Regel (TCMS s8, H5): Der Code-Schluessel entsteht genau einmal. Ein
# vorhandener wird nie neu erzeugt (offene Codes liefen sonst ab), auch nicht
# nach einem Abbruch; ein ungueltiger oder mit einem Token identischer bricht
# ab, ohne die .env zu aendern und ohne den Wert zu nennen.
test_code_key_setup_is_idempotent_resumable_and_strict() {
  local env_file="$TMP_DIR/code-key.env" out="$TMP_DIR/code-key.out" key before token bad
  managed_env "$env_file"
  key="$(env_value "$env_file" TCMS_CODE_SCHLUESSEL)"

  # Abbruch nach dem Schreiben (Strg-C vor dem Rest von setup): der naechste
  # Lauf uebernimmt den Schluessel, statt einen zweiten zu erzeugen.
  tcms_base_env "$env_file.resume"
  if tcms_isolated "$env_file.resume" eval '
    load_env; tcms_ensure_db_passwords; tcms_ensure_managed_credentials; tcms_ensure_code_key
    exit 130' >/dev/null 2>&1; then test_fail "simulated abort did not abort"; fi
  key="$(env_value "$env_file.resume" TCMS_CODE_SCHLUESSEL)"
  [[ -n "$key" ]] || test_fail "code key not written before the abort"
  tcms_isolated "$env_file.resume" eval 'load_env; tcms_configure_managed' >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "setup after an abort failed"; }
  assert_key_equals "$env_file.resume" TCMS_CODE_SCHLUESSEL "$key"
  [[ "$(grep -c '^TCMS_CODE_SCHLUESSEL=' "$env_file.resume")" == "1" ]] || test_fail "code key written twice"
  assert_not_contains "$out" "Code-Schluessel erzeugt"

  # Abbruch vor dem Schreiben: nichts in der .env, der naechste Lauf erzeugt genau einen.
  tcms_base_env "$env_file.early"
  if tcms_isolated "$env_file.early" eval '
    load_env; tcms_ensure_db_passwords; tcms_ensure_managed_credentials
    set_env() { exit 130; }
    tcms_ensure_code_key' >/dev/null 2>&1; then test_fail "simulated early abort did not abort"; fi
  assert_key_equals "$env_file.early" TCMS_CODE_SCHLUESSEL ""
  tcms_isolated "$env_file.early" eval 'load_env; tcms_configure_managed' >/dev/null 2>&1 || test_fail "setup after an early abort failed"
  assert_code_key_format "$env_file.early"

  # Laufende Rotation (zwei Eintraege) bleibt unveraendert.
  cp "$env_file" "$env_file.two"
  token="zweiterCodeSchluesselNurFuerDenTest0123456789"
  sed -i "s|^TCMS_CODE_SCHLUESSEL=.*|&,$token|" "$env_file.two"
  before="$(cat "$env_file.two")"
  tcms_isolated "$env_file.two" eval 'load_env; tcms_configure_managed' >/dev/null 2>&1 || test_fail "setup rejected a rotation list"
  [[ "$(cat "$env_file.two")" == "$before" ]] || test_fail "setup changed a two-entry code key list"

  # Ungueltig: Platzhalter, zu kurz, Leerzeichen, doppelt, gleich einem Token.
  token="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  for bad in "bitte-durch-einen-zufaelligen-code-schluessel-ersetzen" "kurz0123456789" \
    "$key, $key" "$key,$key" "$token" "$key,$token"; do
    cp "$env_file" "$env_file.bad"
    BAD="$bad" "$NODE_BIN" -e '
      const fs = require("node:fs"); const f = process.argv[1];
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^TCMS_CODE_SCHLUESSEL=.*$/m, () => "TCMS_CODE_SCHLUESSEL=" + process.env.BAD));
    ' "$env_file.bad"
    before="$(cat "$env_file.bad")"
    if tcms_isolated "$env_file.bad" eval 'load_env; configure_tcms_for_env' >"$out" 2>&1; then
      test_fail "invalid code key accepted (case $(tcms_code_key_id "$bad"))"
    fi
    assert_contains "$out" "TCMS_CODE_SCHLUESSEL:"
    assert_contains "$out" "wird nicht ersetzt"
    assert_no_secret "$out" "$bad" TCMS_CODE_SCHLUESSEL
    [[ "$(cat "$env_file.bad")" == "$before" ]] || test_fail "a refused code key changed .env"
  done
  assert_contains "$out" "gleicht TCMS_SERVICE_TOKENS"
  pass "code key: generated once, kept after aborts and during rotation, invalid or token-equal values refused"
}

# Regel (TCMS s8, H5): deploy/update erzeugen einen fehlenden Code-Schluessel
# einer bestehenden verwalteten Installation vor jedem Dienstwechsel und
# weisen auf das Ablaufen offener Codes und den H2-CHECK hin; andere Werte
# bleiben unveraendert.
test_update_adds_a_missing_code_key_and_warns_once() {
  local env_file="$TMP_DIR/code-key-upgrade.env" out="$TMP_DIR/code-key-upgrade.out" key before after
  managed_env "$env_file"
  sed -i 's/^TCMS_CODE_SCHLUESSEL=.*$//' "$env_file"
  before="$(grep -v '^TCMS_CODE_SCHLUESSEL=' "$env_file" | grep .)"
  tcms_isolated "$env_file" eval 'load_env; configure_tcms_for_env' >"$out" 2>&1 || { cat "$out" >&2; test_fail "upgrade failed"; }
  assert_code_key_format "$env_file"
  after="$(grep -v '^TCMS_CODE_SCHLUESSEL=' "$env_file" | grep .)"
  [[ "$before" == "$after" ]] || test_fail "upgrade changed other TCMS values"
  assert_contains "$out" "Alle bis dahin ausgestellten Bestaetigungscodes laufen ab"
  assert_contains "$out" "CHECK, der bei Altbestand"
  key="$(env_value "$env_file" TCMS_CODE_SCHLUESSEL)"
  assert_no_secret "$out" "$key" TCMS_CODE_SCHLUESSEL
  tcms_isolated "$env_file" eval 'load_env; configure_tcms_for_env' >"$out" 2>&1 || test_fail "second update failed"
  assert_key_equals "$env_file" TCMS_CODE_SCHLUESSEL "$key"
  assert_not_contains "$out" "Neuer TCMS_CODE_SCHLUESSEL fuer eine bestehende Installation"
  # Neue Installation: kein Rollout-Hinweis.
  tcms_base_env "$env_file.neu"
  tcms_isolated "$env_file.neu" eval 'load_env; tcms_configure_managed' >"$out" 2>&1 || test_fail "new managed setup failed"
  assert_not_contains "$out" "Neuer TCMS_CODE_SCHLUESSEL fuer eine bestehende Installation"
  pass "deploy/update add a missing code key once, before any service, and warn about expiring codes"
}

# Ein neues Dienst-Token darf keinem Code-Schluessel gleichen.
test_new_service_tokens_avoid_the_code_key() {
  local seq="$TMP_DIR/token-avoid.seq" ergebnis zweiter
  zweiter="andererWertFuerDenTest$(printf '%s' 0123456789abcdefghij)"
  printf '0\n' >"$seq"
  ergebnis="$(
    TCMS_CODE_SCHLUESSEL="kollisionsWertFuerDenTest$(printf '%s' 0123456789abcdefgh)"
    rand_b64() {
      local n; n="$(cat "$seq")"; printf '%s\n' $(( n + 1 )) >"$seq"
      if (( n == 0 )); then printf '%s' "$TCMS_CODE_SCHLUESSEL"; else printf '%s' "$zweiter"; fi
    }
    tcms_generate_token
  )"
  [[ "$ergebnis" == "$zweiter" ]] || test_fail "token generation accepted a code key value"
  pass "new service tokens never equal a code key entry"
}

# Regel: kein Geheimnis in Kommandozeilen (Prozessliste) oder Ausgaben.
test_setup_and_rotation_never_expose_secrets() {
  local env_file="$TMP_DIR/setup-argv.env" spies="$TMP_DIR/setup-argv-spies" log="$TMP_DIR/setup-argv.log"
  local out="$TMP_DIR/setup-argv.out" calls="$TMP_DIR/setup-argv.calls" key value snapshot
  tcms_base_env "$env_file"
  : >"$log"; : >"$calls"
  install_argv_spies "$spies" "$log" openssl base64 tr sha256sum cut grep sed cat mv chmod mktemp head date rm cp stat
  ROTATION_STATE="$TMP_DIR/setup-argv.rotation" INSTALL_STATE="$TMP_DIR/setup-argv.state" \
  CODE_ROTATION_STATE="$TMP_DIR/setup-argv.code-rotation" \
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
    cp "$ENVFILE" "$ENVFILE.nach-setup"
    cmd_tcms_rotate token
    cmd_tcms_rotate key
    cmd_tcms_rotate_code_key
    cp "$TCMS_CODE_KEY_ROTATION_STATE" "$ENVFILE.code-rotation"
    cmd_tcms_status
    FAKE_NOW=$(( FAKE_NOW + 604800 ))
    cmd_tcms_rotate_code_key --finish
    cmd_tcms_status
  ' >"$out" 2>&1 || { cat "$out" >&2; test_fail "setup/rotation failed"; }
  [[ -s "$log" ]] || test_fail "argv spies were not used"
  assert_contains "$log" "openssl genpkey -algorithm ed25519"
  # Werte nach dem Setup (alt) und nach allen Rotationen (neu).
  for snapshot in "$env_file.nach-setup" "$env_file"; do
    for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD \
      TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY TCMS_CODE_SCHLUESSEL; do
      value="$(env_value "$snapshot" "$key")"
      [[ -n "$value" ]] || test_fail "$key missing after setup"
      assert_no_secret "$log" "$value" "$key"
      assert_no_secret "$calls" "$value" "$key"
      assert_no_secret "$out" "$value" "$key"
      assert_no_secret "$env_file.code-rotation" "$value" "$key"
    done
  done
  [[ "$(env_value "$env_file.nach-setup" TCMS_CODE_SCHLUESSEL)" != "$(env_value "$env_file" TCMS_CODE_SCHLUESSEL)" ]] || \
    test_fail "code key was not rotated"
  pass "setup and rotation keep every TCMS secret out of command lines, docker calls, state and output"
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

# Compose-Attrappe fuer die Code-Schluessel-Rotation: protokolliert je
# Neustart von tcms-api die Kennungen der Liste (nie Werte).
code_rotation_stubs() {
  cat <<'STUBS'
compose() {
  if [[ "$*" == *"tcms-api"* ]]; then
    printf 'API t=%s codes=%s\n' "$FAKE_NOW" "$(tcms_code_key_ids "$TCMS_CODE_SCHLUESSEL")" >>"$CALLS"
    [[ -z "${FAIL_API_ONCE:-}" || -e "$FAIL_API_ONCE" ]] || { : >"$FAIL_API_ONCE"; return 1; }
  fi
  return 0
}
docker() { return 0; }
tcms_now() { printf '%s' "$FAKE_NOW"; }
if [[ -n "${ABORT_ON_CODE_KEY_WRITE:-}" ]]; then
  tcms_set() { [[ "$1" != TCMS_CODE_SCHLUESSEL ]] || exit 130; set_env "$1" "$2"; export "$1=$2"; }
fi
STUBS
}

run_code_rotation() {
  local env_file="$1"
  shift
  ROT_ARGS="$*" tcms_isolated "$env_file" eval "$(code_rotation_stubs)"'
    FAKE_NOW="$(cat "$CLOCK")"
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Optionen des Testfalls
    cmd_tcms_rotate_code_key $ROT_ARGS'
}

code_key_of() { env_value "$1" TCMS_CODE_SCHLUESSEL; }

# Regel (TCMS s8, H5): Der neue Code-Schluessel steht vorn (signiert), der
# alte prueft weiter und verschwindet fruehestens 7 Tage nach dem Neustart
# von tcms-api mit NEU,ALT.
test_code_key_rotation_keeps_the_old_key_for_seven_days() {
  local env_file="$TMP_DIR/ck-rot.env" out="$TMP_DIR/ck-rot.out" old new old_id new_id
  export CALLS="$TMP_DIR/ck-rot.calls" CLOCK="$TMP_DIR/ck-rot.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/ck-rot.rotation" INSTALL_STATE="$TMP_DIR/ck-rot.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  old="$(code_key_of "$env_file")"; old_id="$(tcms_code_key_id "$old")"
  run_code_rotation "$env_file" >"$out" 2>&1 || { cat "$out" >&2; test_fail "code key rotation start failed"; }
  [[ "$(code_key_of "$env_file")" == *",$old" ]] || test_fail "old key is not kept as the second entry"
  new="$(code_key_of "$env_file")"; new="${new%%,*}"; new_id="$(tcms_code_key_id "$new")"
  [[ "$new" =~ ^[A-Za-z0-9_-]{43}$ && "$new" != "$old" ]] || test_fail "no new 32-byte key in front"
  [[ "$(cat "$CALLS")" == "API t=1700000000 codes=$new_id, $old_id" ]] || {
    cat "$CALLS" >&2; test_fail "tcms-api was not restarted with new,old"; }
  grep -qx 'phase=published' "$CODE_ROTATION_STATE" && grep -qx 'published_at_epoch=1700000000' "$CODE_ROTATION_STATE" || \
    test_fail "rotation state is not published at the restart time"
  [[ "$(file_mode "$CODE_ROTATION_STATE")" == "600" ]] || test_fail "code key rotation state is not 0600"
  assert_contains "$out" "fruehestens $(tcms_format_epoch 1700604800)"
  # Zweiter Start waehrend der Ueberlappung: Abbruch, kein neuer Schluessel.
  if run_code_rotation "$env_file" --start >"$out" 2>&1; then test_fail "a second start during the overlap succeeded"; fi
  assert_contains "$out" "laeuft seit"
  [[ "$(code_key_of "$env_file")" == "$new,$old" ]] || test_fail "second start changed the key list"
  # Eine Sekunde zu frueh: Abbruch mit Hinweis, nichts geaendert, kein Neustart.
  : >"$CALLS"; printf '1700604799' >"$CLOCK"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "finish before seven days succeeded"; fi
  assert_contains "$out" "Abschluss fruehestens $(tcms_format_epoch 1700604800) (noch 0 Tage 0 Std 0 Min)"
  assert_contains "$out" "--force --confirm-expiry OFFENE_CODES_LAUFEN_AB"
  [[ "$(code_key_of "$env_file")" == "$new,$old" && ! -s "$CALLS" ]] || \
    test_fail "an early finish changed the key list or restarted tcms-api"
  # Nach 7 Tagen: ALT entfernt, Neustart, Zustand weg.
  printf '1700604800' >"$CLOCK"
  run_code_rotation "$env_file" --finish >"$out" 2>&1 || { cat "$out" >&2; test_fail "finish after seven days failed"; }
  assert_key_equals "$env_file" TCMS_CODE_SCHLUESSEL "$new"
  [[ "$(cat "$CALLS")" == "API t=1700604800 codes=$new_id" ]] || test_fail "tcms-api not restarted with the new key only"
  [[ ! -e "$CODE_ROTATION_STATE" ]] || test_fail "rotation state left behind"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "finish without an open rotation succeeded"; fi
  assert_contains "$out" "Keine Code-Schluessel-Rotation offen"
  pass "code key rotation: the new key signs first, the old one stays seven days after the restart"
}

# Regel: Wiederaufnahme ohne zweiten Schluessel; die Frist laeuft ab dem
# erfolgreichen Neustart; --force nur zum Abschluss und nur mit Wort.
test_code_key_rotation_resumes_and_forces_only_with_the_word() {
  local env_file="$TMP_DIR/ck-res.env" out="$TMP_DIR/ck-res.out" list args old state_new
  export CALLS="$TMP_DIR/ck-res.calls" CLOCK="$TMP_DIR/ck-res.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/ck-res.rotation" INSTALL_STATE="$TMP_DIR/ck-res.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  # 1) Neustart scheitert: Phase prepared, Liste NEU,ALT schon in der .env.
  if FAIL_API_ONCE="$TMP_DIR/ck-res.api-failed" run_code_rotation "$env_file" >"$out" 2>&1; then
    test_fail "rotation reported success although tcms-api did not become healthy"
  fi
  grep -qx 'phase=prepared' "$CODE_ROTATION_STATE" || test_fail "state is not prepared after a failed restart"
  list="$(code_key_of "$env_file")"
  [[ "$list" == *,* ]] || test_fail "new,old not written before the restart"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "finish accepted an unpublished rotation"; fi
  assert_contains "$out" "Phase prepared"
  # 2) Spaeter fortsetzen: derselbe neue Schluessel, Frist ab diesem Neustart.
  printf '1700001000' >"$CLOCK"
  run_code_rotation "$env_file" >"$out" 2>&1 || { cat "$out" >&2; test_fail "resume failed"; }
  [[ "$(code_key_of "$env_file")" == "$list" ]] || test_fail "resume generated another key"
  grep -qx 'published_at_epoch=1700001000' "$CODE_ROTATION_STATE" || test_fail "overlap does not start at the successful restart"
  # 3) 7 Tage nach dem Erzeugen, aber vor 7 Tagen nach dem Neustart: zu frueh.
  printf '1700604800' >"$CLOCK"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "overlap counted from the creation instead of the restart"; fi
  # 4) --force ohne bzw. mit falschem Wort, oder Wort ohne --force: Abbruch vor jeder Wirkung.
  : >"$CALLS"
  for args in "--finish --force" "--finish --force --confirm-expiry ja" "--force --confirm-expiry OFFENE_CODES_LAUFEN_AB" \
    "--finish --confirm-expiry OFFENE_CODES_LAUFEN_AB" "--finish --unbekannt"; do
    # shellcheck disable=SC2086 # Wortzerlegung gewollt: Optionen des Testfalls
    if run_code_rotation "$env_file" $args >"$out" 2>&1; then test_fail "accepted: $args"; fi
    [[ "$(code_key_of "$env_file")" == "$list" && ! -s "$CALLS" ]] || test_fail "refused options changed something: $args"
  done
  assert_contains "$out" "Unbekannte Option"
  # 5) Mit Wort: Warnung, ALT entfernt, Neustart.
  run_code_rotation "$env_file" --finish --force --confirm-expiry OFFENE_CODES_LAUFEN_AB >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "forced finish failed"; }
  assert_contains "$out" "offene Codes laufen ab"
  assert_key_equals "$env_file" TCMS_CODE_SCHLUESSEL "${list%%,*}"
  [[ ! -e "$CODE_ROTATION_STATE" ]] || test_fail "state left after the forced finish"
  # 6) Abbruch zwischen Zustand und .env: der naechste Lauf beginnt neu und
  #    schreibt genau einen neuen Schluessel vor den alten.
  old="$(code_key_of "$env_file")"
  if ABORT_ON_CODE_KEY_WRITE=1 run_code_rotation "$env_file" >"$out" 2>&1; then test_fail "simulated abort did not abort"; fi
  [[ "$(code_key_of "$env_file")" == "$old" ]] || test_fail "aborted start changed .env"
  state_new="$(grep '^new_id=' "$CODE_ROTATION_STATE" | cut -d= -f2)"
  run_code_rotation "$env_file" >"$out" 2>&1 || { cat "$out" >&2; test_fail "restart after the abort failed"; }
  assert_contains "$out" "Rotation beginnt neu"
  list="$(code_key_of "$env_file")"
  [[ "$list" == *",$old" && "$list" != *,*,* ]] || test_fail "restart after the abort did not produce exactly new,old"
  [[ "$(grep '^new_id=' "$CODE_ROTATION_STATE" | cut -d= -f2)" == "$(tcms_code_key_id "${list%%,*}")" && \
     "$(tcms_code_key_id "${list%%,*}")" != "$state_new" ]] || test_fail "state does not describe the key in .env"
  pass "code key rotation resumes without a second key and forces only with the confirmation word"
}

# Regel: Zustand nur Kennungen und Zeitpunkte; Abweisungen vor jeder Wirkung.
test_code_key_rotation_state_and_refusals() {
  local env_file="$TMP_DIR/ck-ref.env" out="$TMP_DIR/ck-ref.out" line first
  export CALLS="$TMP_DIR/ck-ref.calls" CLOCK="$TMP_DIR/ck-ref.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/ck-ref.rotation" INSTALL_STATE="$TMP_DIR/ck-ref.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  run_code_rotation "$env_file" >/dev/null 2>&1 || test_fail "rotation start failed"
  while IFS= read -r line; do
    [[ "$line" =~ ^(format=1|kind=code-key|phase=(prepared|published)|(old|new)_id=csk:[0-9a-f]{16}|(created|published)_at_epoch=([0-9]{10})?)$ ]] || \
      test_fail "unexpected line in the rotation state: ${line%%=*}"
  done <"$CODE_ROTATION_STATE"
  # Manipulierter Zustand (Gruppenrechte, fremde Zeile): kein Raten.
  chmod 0640 "$CODE_ROTATION_STATE"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "state with group rights accepted"; fi
  assert_contains "$out" "Modus 0600"
  chmod 0600 "$CODE_ROTATION_STATE"; sed -i 's/^kind=code-key$/kind=token/' "$CODE_ROTATION_STATE"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "state of another kind accepted"; fi
  assert_contains "$out" "ungueltig"
  # Zwei Eintraege ohne Zustand: Start abgewiesen, Abschluss nur mit --force
  # (der erste Eintrag bleibt).
  rm -f "$CODE_ROTATION_STATE"; : >"$CALLS"
  if run_code_rotation "$env_file" >"$out" 2>&1; then test_fail "start accepted a two-entry list without state"; fi
  assert_contains "$out" "mehrere Eintraege ohne laufende Rotation"
  if run_code_rotation "$env_file" --finish >"$out" 2>&1; then test_fail "finish without state and without force succeeded"; fi
  assert_contains "$out" "Startzeitpunkt ist unbekannt"
  [[ ! -s "$CALLS" ]] || test_fail "refused commands restarted tcms-api"
  first="$(code_key_of "$env_file")"; first="${first%%,*}"
  run_code_rotation "$env_file" --finish --force --confirm-expiry OFFENE_CODES_LAUFEN_AB >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "forced finish without state failed"; }
  assert_key_equals "$env_file" TCMS_CODE_SCHLUESSEL "$first"
  # Nur verwaltet.
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=external/' "$env_file"; : >"$CALLS"
  if run_code_rotation "$env_file" >"$out" 2>&1; then test_fail "rotation ran for an external Tax-CMS"; fi
  assert_contains "$out" "gilt fuer TCMS_DEPLOYMENT=managed"
  [[ ! -s "$CALLS" && ! -e "$CODE_ROTATION_STATE" ]] || test_fail "refused rotation had side effects"
  pass "code key rotation state holds only ids and times; refusals happen before any side effect"
}

# Regel: Eine vorbereitete Rotation startet tcms-api nur mit genau NEU,ALT
# laut Zustand. Vertauscht, fremd, unvollstaendig oder mit drittem Eintrag:
# Abbruch vor dem Neustart; .env und Zustand bleiben, wie sie sind.
test_code_key_rotation_publish_refuses_a_list_that_does_not_match_the_state() {
  local env_file="$TMP_DIR/ck-pub.env" out="$TMP_DIR/ck-pub.out" list new old fremd state_before falsch
  export CALLS="$TMP_DIR/ck-pub.calls" CLOCK="$TMP_DIR/ck-pub.clock"
  export CODE_ROTATION_STATE="$TMP_DIR/ck-pub.rotation" INSTALL_STATE="$TMP_DIR/ck-pub.state"
  managed_env "$env_file"; : >"$CALLS"; printf '1700000000' >"$CLOCK"
  if FAIL_API_ONCE="$TMP_DIR/ck-pub.api-failed" run_code_rotation "$env_file" >"$out" 2>&1; then
    test_fail "rotation reported success although tcms-api did not become healthy"
  fi
  grep -qx 'phase=prepared' "$CODE_ROTATION_STATE" || test_fail "state is not prepared after a failed restart"
  list="$(code_key_of "$env_file")"; new="${list%%,*}"; old="${list#*,}"
  [[ -n "$new" && -n "$old" && "$old" != *,* ]] || test_fail "prepared list is not new,old"
  fremd="fremderSchluesselFuerDenTest$(printf '%s' 0123456789abcdefgh)"
  state_before="$(cat "$CODE_ROTATION_STATE")"
  for falsch in "$old,$new" "$new" "$fremd,$old" "$new,$fremd" "$new,$old,$fremd"; do
    sed -i "s|^TCMS_CODE_SCHLUESSEL=.*|TCMS_CODE_SCHLUESSEL=$falsch|" "$env_file"; : >"$CALLS"
    if run_code_rotation "$env_file" >"$out" 2>&1; then
      test_fail "publish accepted a key list that does not match the state ($(tcms_code_key_ids "$falsch"))"
    fi
    assert_contains "$out" "passt nicht zum Rotationszustand"
    [[ ! -s "$CALLS" ]] || test_fail "tcms-api restarted with a list that does not match the state ($(tcms_code_key_ids "$falsch"))"
    [[ "$(code_key_of "$env_file")" == "$falsch" ]] || test_fail "refused publish rewrote TCMS_CODE_SCHLUESSEL"
    [[ "$(cat "$CODE_ROTATION_STATE")" == "$state_before" ]] || test_fail "refused publish changed the rotation state"
  done
  # Gegenprobe: mit der passenden Liste laeuft dieselbe Rotation weiter.
  sed -i "s|^TCMS_CODE_SCHLUESSEL=.*|TCMS_CODE_SCHLUESSEL=$new,$old|" "$env_file"; : >"$CALLS"
  run_code_rotation "$env_file" >"$out" 2>&1 || { cat "$out" >&2; test_fail "publish with the matching list failed"; }
  [[ "$(cat "$CALLS")" == "API t=1700000000 codes=$(tcms_code_key_id "$new"), $(tcms_code_key_id "$old")" ]] || {
    cat "$CALLS" >&2; test_fail "tcms-api was not restarted with new,old"; }
  grep -qx 'phase=published' "$CODE_ROTATION_STATE" || test_fail "matching publish did not reach phase published"
  pass "a prepared rotation restarts tcms-api only with exactly new,old from the state"
}

# Regel: Ein neuer Code-Schluessel ist genau 43 Zeichen base64url (32 Byte)
# und ein gueltiges Geheimnis; sonst neuer Versuch, nach fuenf Fehlversuchen
# Abbruch statt eines schwachen Schluessels.
test_new_code_keys_are_43_char_base64url_and_valid() {
  local seq="$TMP_DIR/ck-gen.seq" out="$TMP_DIR/ck-gen.out" gut ergebnis schlecht
  gut="gueltigerCodeSchluesselFuerTest$(printf '%s' 0123456789AB)"
  [[ ${#gut} == 43 ]] || test_fail "test value has the wrong length"
  # Je ein Fehlerfall vor einem gueltigen Wert: der gueltige gewinnt.
  for schlecht in \
    "$(printf 'A%.0s' {1..43})" \
    "${gut:0:42}" \
    "${gut}x" \
    "${gut:0:41}+/" \
    "${gut:0:42}="; do
    printf '0\n' >"$seq"
    ergebnis="$(
      unset "${TCMS_CONFIG_VARS[@]}"
      rand_b64() {
        local n; n="$(cat "$seq")"; printf '%s\n' $(( n + 1 )) >"$seq"
        if (( n == 0 )); then printf '%s' "$schlecht"; else printf '%s' "$gut"; fi
      }
      tcms_generate_code_key ""
    )" || test_fail "generator gave up after one rejected candidate"
    [[ "$ergebnis" == "$gut" ]] || test_fail "generator accepted an invalid candidate (${#schlecht} chars)"
  done
  # Nur ungueltige Werte: Abbruch, keine Ausgabe auf stdout.
  if ergebnis="$(
    unset "${TCMS_CONFIG_VARS[@]}"
    rand_b64() { printf '%s' "${gut:0:42}"; }
    tcms_generate_code_key "" 2>"$out"
  )"; then
    test_fail "generator returned a key although every candidate was invalid"
  fi
  [[ -z "$ergebnis" ]] || test_fail "generator printed a value although it failed"
  assert_contains "$out" "konnte nicht sicher erzeugt werden"
  pass "new code keys are 43-char base64url and valid tokens; invalid candidates are never used"
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
  # Wechsel extern -> verwaltet: nie das Token des externen Betreibers weiterverwenden.
  tcms_isolated "$env_file" cmd_tcms_setup managed --no-start </dev/null >"$out" 2>&1 || {
    cat "$out" >&2; test_fail "switch from external to managed failed"
  }
  assert_key_equals "$env_file" TCMS_DEPLOYMENT managed
  [[ "$(env_value "$env_file" TCMS_SERVICE_TOKEN)" != "externTokenMitGenugZeichen0123456789ab" ]] || \
    test_fail "managed mode reused the external operator's token"
  [[ "$(env_value "$env_file" TCMS_SERVICE_TOKENS)" == "$(env_value "$env_file" TCMS_SERVICE_TOKEN)" ]] || \
    test_fail "managed token list does not hold the new token"
  pass "external setup requires HTTPS and a real token and prints only the public key"
}

test_disable_restarts_writers_first_and_keeps_the_database_volume() {
  local env_file="$TMP_DIR/disable.env" calls="$TMP_DIR/disable.calls" super
  managed_env "$env_file"; : >"$calls"
  super="$(env_value "$env_file" TCMS_DB_SUPERUSER_PASSWORD)"
  printf 'current=1.0.0\n' >"$TMP_DIR/disable.state"
  printf 'format=1\n' >"$TMP_DIR/disable.code-rotation"
  CODE_ROTATION_STATE="$TMP_DIR/disable.code-rotation" \
  INSTALL_STATE="$TMP_DIR/disable.state" tcms_isolated "$env_file" eval '
    compose() { printf "compose %s TCMS_DEPLOYMENT=%s TCMS_URL=%s\n" "$*" "$TCMS_DEPLOYMENT" "${TCMS_URL:-}" >>"'"$calls"'"; }
    docker() { printf "docker %s\n" "$*" >>"'"$calls"'"; return 0; }
    smoke_health() { :; }
    load_env; cmd_tcms_disable
  ' >/dev/null 2>&1 || test_fail "disable failed"
  assert_key_equals "$env_file" TCMS_DEPLOYMENT disabled
  for key in TCMS_URL TCMS_SERVICE_TOKEN TCMS_ACTOR_PRIVATE_KEY TCMS_ACTOR_KEY_ID TCMS_SERVICE_TOKENS TCMS_ACTOR_PUBLIC_KEYS \
    TCMS_CODE_SCHLUESSEL; do
    assert_key_equals "$env_file" "$key" ""
  done
  assert_key_equals "$env_file" TCMS_DB_SUPERUSER_PASSWORD "$super"
  [[ ! -e "$TMP_DIR/disable.code-rotation" ]] || test_fail "disable kept the code key rotation state"
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

write_code_rotation_state() {
  local file="$1" phase="$2" old="$3" new="$4" created="$5" published="$6"
  printf 'format=1\nkind=code-key\nphase=%s\nold_id=%s\nnew_id=%s\ncreated_at_epoch=%s\npublished_at_epoch=%s\n' \
    "$phase" "$old" "$new" "$created" "$published" >"$file"
  chmod 0600 "$file"
}

# Regel (TCMS s8, H5): doctor und status pruefen nur Vorhandensein, Format,
# Anzahl und Rotationsstand des Code-Schluessels und geben nie einen Wert
# aus. Fehlt er oder ist er ungueltig, meldet doctor FEHLT; prepare_env
# bricht deploy/update damit vor jeder Wirkung ab.
test_doctor_and_status_check_the_code_key_without_values() {
  local env_file="$TMP_DIR/doctor-ck.env" out="$TMP_DIR/doctor-ck.out" key token second variant
  local clock='tcms_now() { printf 1700100000; }'
  export CODE_ROTATION_STATE="$TMP_DIR/doctor-ck.rotation"
  managed_env "$env_file"
  key="$(code_key_of "$env_file")"; token="$(env_value "$env_file" TCMS_SERVICE_TOKEN)"
  run_tcms_doctor "$env_file" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "OK       TCMS_CODE_SCHLUESSEL   1 Eintrag, Format gueltig"
  assert_contains "$out" "ERRS=0"
  assert_no_secret "$out" "$key" TCMS_CODE_SCHLUESSEL
  for variant in fehlt kurz token; do
    cp "$env_file" "$env_file.$variant"
    case "$variant" in
      fehlt) sed -i 's/^TCMS_CODE_SCHLUESSEL=.*/TCMS_CODE_SCHLUESSEL=/' "$env_file.$variant" ;;
      kurz) sed -i 's/^TCMS_CODE_SCHLUESSEL=.*/TCMS_CODE_SCHLUESSEL=kurz0123456789/' "$env_file.$variant" ;;
      token) sed -i "s/^TCMS_CODE_SCHLUESSEL=.*/TCMS_CODE_SCHLUESSEL=$token/" "$env_file.$variant" ;;
    esac
    run_tcms_doctor "$env_file.$variant" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
    assert_contains "$out" "FEHLT    TCMS_CODE_SCHLUESSEL"
    assert_not_contains "$out" "ERRS=0"
    assert_no_secret "$out" "$token" TCMS_SERVICE_TOKEN
    assert_no_secret "$out" "$key" TCMS_CODE_SCHLUESSEL
  done
  assert_contains "$out" "gleicht TCMS_SERVICE_TOKENS"

  # Zwei Eintraege: laufende Rotation (OK mit Termin), faellig, unterbrochen,
  # beschaedigter Zustand, kein Zustand (jeweils WARN, nie FEHLT).
  second="zweiterCodeSchluesselNurFuerDenTest0123456789"
  cp "$env_file" "$env_file.two"
  sed -i "s|^TCMS_CODE_SCHLUESSEL=.*|TCMS_CODE_SCHLUESSEL=$second,$key|" "$env_file.two"
  write_code_rotation_state "$CODE_ROTATION_STATE" published "$(tcms_code_key_id "$key")" "$(tcms_code_key_id "$second")" 1700000000 1700000000
  run_tcms_doctor "$env_file.two" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1;'"$clock"
  assert_contains "$out" "OK       TCMS_CODE_ROTATION     2 Eintraege; Abschluss ab $(tcms_format_epoch 1700604800)"
  assert_contains "$out" "ERRS=0 WARNS=0"
  run_tcms_doctor "$env_file.two" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1; tcms_now() { printf 1700604800; }'
  assert_contains "$out" "WARN     TCMS_CODE_ROTATION     Abschluss faellig seit $(tcms_format_epoch 1700604800)"
  # status: Anzahl, Kennungen und Termin, keine Werte.
  tcms_isolated "$env_file.two" eval '
    docker() { return 1; }
    '"$clock"'
    cmd_tcms_status' >"$out" 2>&1 || { cat "$out" >&2; test_fail "status failed"; }
  assert_contains "$out" "Code-Schluessel  : 2 Eintrag/Eintraege ($(tcms_code_key_id "$second"), $(tcms_code_key_id "$key")), Format gueltig; signiert: $(tcms_code_key_id "$second")"
  assert_contains "$out" "Code-Rotation    : seit $(tcms_format_epoch 1700000000) ($(tcms_code_key_id "$key") -> $(tcms_code_key_id "$second")); Abschluss ab $(tcms_format_epoch 1700604800)"
  assert_no_secret "$out" "$key" TCMS_CODE_SCHLUESSEL
  assert_no_secret "$out" "$second" TCMS_CODE_SCHLUESSEL
  write_code_rotation_state "$CODE_ROTATION_STATE" prepared "$(tcms_code_key_id "$key")" "$(tcms_code_key_id "$second")" 1700000000 ""
  run_tcms_doctor "$env_file.two" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "WARN     TCMS_CODE_ROTATION     Start unterbrochen"
  chmod 0644 "$CODE_ROTATION_STATE"
  run_tcms_doctor "$env_file.two" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "WARN     TCMS_CODE_ROTATION     Rotationszustand muss dem Operator gehoeren"
  rm -f "$CODE_ROTATION_STATE"
  run_tcms_doctor "$env_file.two" "$out" '_TAXTRONIK_INTERNAL_DOCTOR_CONFIG_ONLY=1'
  assert_contains "$out" "WARN     TCMS_CODE_SCHLUESSEL   2 Eintraege ohne Rotationszustand"
  assert_contains "$out" "ERRS=0"
  assert_no_secret "$out" "$second" TCMS_CODE_SCHLUESSEL
  pass "doctor and status check presence, format, count and rotation of the code key without values"
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
    provide_traefik_for_deploy provide_signal_for_deploy tcms_preflight_for_deploy provide_tcms_images backup_before_migrations
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
    # TCMS s8 (H5): Code-Schluessel-Pruefung vor Images, Backup und Migrationen.
    assert_before "$steps" "tcms_preflight_for_deploy" "provide_tcms_images"
    [[ "$fn" == continue_update_after_checkout ]] || assert_before "$steps" "tcms_preflight_for_deploy" "backup_before_migrations"
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
    TCMS_CODE_SCHLUESSEL="${CODE_KEY-wegwerfCodeSchluesselStart$(printf '%s' 0123456789abcdefgh)}"
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
  assert_contains "$out" "CHECK der Migration nachricht_abgerufen bei Altbestand: docs/operations/tcms-betrieb.md"
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
  # TCMS s8 (H5): ohne gueltigen Code-Schluessel weder Datenbank noch Backup,
  # Migration oder Dienstwechsel; der alte tcms-api laeuft weiter.
  for bad in "" "kurz0123456789"; do
    : >"$calls"
    if CODE_KEY="$bad" start_with 0 0 t >"$out" 2>&1; then test_fail "TCMS start without a valid code key succeeded"; fi
    assert_contains "$out" "TCMS_CODE_SCHLUESSEL:"
    assert_contains "$out" "der laufende Dienst bleibt unveraendert"
    [[ ! -s "$calls" ]] || test_fail "TCMS start touched services without a valid code key"
  done
  : >"$calls"
  if ( ENVFILE="$env_file"; TCMS_DEPLOYMENT=managed; TCMS_CODE_SCHLUESSEL=""; tcms_preflight_for_deploy ) >"$out" 2>&1; then
    test_fail "deploy preflight accepted a missing code key"
  fi
  ( ENVFILE="$env_file"; TCMS_DEPLOYMENT=disabled; TCMS_CODE_SCHLUESSEL=""; tcms_preflight_for_deploy ) >"$out" 2>&1 || \
    test_fail "deploy preflight demanded a code key without managed TCMS"
  # tcms setup auf einer laufenden Installation (tcms_activate) ebenso.
  if (
    ENVFILE="$env_file"; TCMS_DEPLOYMENT=managed; TCMS_CODE_SCHLUESSEL=""
    compose() { printf 'compose %s\n' "$*" >>"$calls"; }
    docker() { printf 'docker %s\n' "$*" >>"$calls"; }
    start_tcms_services
  ) >"$out" 2>&1; then test_fail "setup started TCMS without a code key"; fi
  [[ ! -s "$calls" ]] || test_fail "setup touched TCMS services without a code key"
  pass "TCMS start: code key, database, backup of an existing schema, migration with checked exit code, api, fallback"
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
  ( cd "$(dirname "$file")" && sha256sum -- "$(basename "$file")" >"$(basename "$file").sha256" )
  (
    S3_ACCESS_KEY=wegwerfak S3_SECRET_KEY="wegwerf-s3-$s3_marker" S3_BUCKET_BACKUPS=backups
    docker() { printf 'docker %s secret=%s\n' "$*" "${AWS_SECRET_ACCESS_KEY:+gesetzt}" >>"$calls"; }
    upload_tcms_backup "$file"
  ) >/dev/null
  assert_contains "$calls" "-e AWS_SECRET_ACCESS_KEY "
  assert_contains "$calls" "secret=gesetzt"
  assert_contains "$calls" "s3://backups/tcmsdump/"
  assert_contains "$calls" "--network taxtronik"
  assert_contains "$calls" "--include $(basename "$file") --include $(basename "$file").sha256"
  assert_not_contains "$calls" "wegwerf-s3-$s3_marker"
  # Ohne Pruefsummen-Beidatei wird nichts hochgeladen.
  rm -f "$file.sha256"; : >"$calls"
  if ( docker() { printf 'docker %s\n' "$*" >>"$calls"; }; upload_tcms_backup "$file" ) >/dev/null 2>&1; then
    test_fail "upload without checksum file succeeded"
  fi
  [[ ! -s "$calls" ]] || test_fail "upload without checksum file touched docker"
  pass "TCMS dump upload sends dump and checksum to the backups bucket, S3 secrets only by name"
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

# TCMS s8 (H5): Der Code-Schluessel steht nur in der .env; das Full-Backup
# verschluesselt sie und, falls eine Rotation laeuft, deren Zustand mit.
test_full_backup_keeps_env_and_a_running_code_key_rotation() {
  local root="$TMP_DIR/full-ck" payload="$TMP_DIR/full-ck-payload" dest="$TMP_DIR/full-ck-dest" entries
  mkdir -p "$root" "$payload/database" "$dest"
  printf 'TCMS_CODE_SCHLUESSEL=wegwerf\n' >"$root/.env"
  write_code_rotation_state "$root/.taxtronik.tcms-code-key-rotation" published \
    "csk:$(printf '1%.0s' {1..16})" "csk:$(printf '2%.0s' {1..16})" 1700000000 1700000000
  full_backup_entries() (
    ROOT="$root"; STATE="$root/.taxtronik.state"
    TCMS_CODE_KEY_ROTATION_STATE="$root/.taxtronik.tcms-code-key-rotation"
    BACKUP_AGE_RECIPIENT=age1wegwerf
    require_cmd() { :; }
    # age-Attrappe: schreibt den Klartext-Strom, damit der Inhalt pruefbar ist.
    age() {
      local out=""
      while (( $# > 0 )); do [[ "$1" != --output ]] || { out="$2"; shift; }; shift; done
      cat >"$out"
    }
    rm -f "$dest/full-backup.tar.age"
    encrypt_full_backup_payload "$payload" "$dest" >/dev/null
    tar -tf "$dest/full-backup.tar.age"
  )
  entries="$(full_backup_entries)"
  grep -qx '.env' <<<"$entries" || test_fail ".env missing in the full backup"
  grep -qx '.taxtronik.tcms-code-key-rotation' <<<"$entries" || test_fail "running code key rotation missing in the full backup"
  rm -f "$root/.taxtronik.tcms-code-key-rotation"
  entries="$(full_backup_entries)"
  ! grep -q 'tcms-code-key-rotation' <<<"$entries" || test_fail "full backup lists a rotation state that does not exist"
  pass "full backup encrypts .env with the code key and a running code key rotation state"
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
  # Pruefsumme ist Pflicht: fehlend, als Symlink oder fuer eine andere Datei.
  local good="$TMP_DIR/restore-val/ok.dump" scenario
  printf 'PGDMP-ok' >"$good"
  for scenario in missing symlink other-name two-lines; do
    rm -f "$good.sha256"
    case "$scenario" in
      symlink) ( cd "$(dirname "$good")" && sha256sum ok.dump >real.sha256 && ln -sf real.sha256 ok.dump.sha256 ) ;;
      # Beidatei nennt eine andere, gueltige Datei: --check allein wuerde passen.
      other-name) ( cd "$(dirname "$good")" && printf 'PGDMP-anders' >anders.dump && sha256sum anders.dump >ok.dump.sha256 ) ;;
      two-lines) ( cd "$(dirname "$good")" && { sha256sum ok.dump; sha256sum ok.dump; } >ok.dump.sha256 ) ;;
    esac
    : >"$calls"
    if (
      ENVFILE="$TMP_DIR/restore-val.no-env"
      docker() { printf 'docker %s\n' "$*" >>"$calls"; }
      compose() { printf 'compose %s\n' "$*" >>"$calls"; }
      cmd_tcms_restore --file "$good" --confirm-overwrite RESTORE_TCMS_DATABASE
    ) >"$out" 2>&1; then test_fail "restore accepted checksum scenario: $scenario"; fi
    [[ ! -s "$calls" ]] || test_fail "restore touched services in checksum scenario: $scenario"
    # Abgewiesen von der Pruefsummenregel selbst, nicht erst von einer spaeteren Stufe.
    case "$scenario" in
      missing | symlink) assert_contains "$out" "Pruefsummen-Datei $good.sha256 fehlt" ;;
      *) assert_contains "$out" "muss genau den Dump nennen" ;;
    esac
  done
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

# ---------------------------------------------------------------------------
# kk-tcms-s11 Punkt 6: Zeitplan, Rotation und Alter der TCMS-Sicherung
# ---------------------------------------------------------------------------
test_tcms_backup_schedule_installs_idempotently_and_keeps_other_entries() {
  local env_file="$TMP_DIR/sched.env" out="$TMP_DIR/sched.out" line log
  export FAKE_CRONTAB="$TMP_DIR/sched.crontab"
  managed_env "$env_file"
  printf '# eigene Eintraege\n0 3 * * * /usr/local/bin/eigener-job\n' >"$FAKE_CRONTAB"
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install' >"$out" 2>&1 || test_fail "install failed"
  log="$TMP_DIR/backups-host/tcms-zeitplan/zeitplan.log"
  line="30 1 * * * cd '$REPO_ROOT' && ./taxtronik tcms backup --zeitplan >'$log' 2>&1"
  assert_contains "$FAKE_CRONTAB" "0 3 * * * /usr/local/bin/eigener-job"
  assert_contains "$FAKE_CRONTAB" "# >>> taxtronik tcms-backup"
  assert_contains "$FAKE_CRONTAB" "$line"
  assert_contains "$FAKE_CRONTAB" "# <<< taxtronik tcms-backup <<<"
  [[ "$(grep -c -- '--zeitplan' "$FAKE_CRONTAB")" == "1" ]] || test_fail "schedule line missing or duplicated"
  [[ "$(file_mode "$TMP_DIR/backups-host/tcms-zeitplan")" == "700" ]] || test_fail "schedule directory is not 0700"
  # Zweiter Lauf: unveraendert, kein zweiter Block.
  cp "$FAKE_CRONTAB" "$TMP_DIR/sched.vorher"
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install; tcms_backup_schedule_installed' >"$out" 2>&1 || \
    test_fail "second install or status failed"
  cmp -s "$FAKE_CRONTAB" "$TMP_DIR/sched.vorher" || test_fail "second install changed the crontab"
  # Ein veralteter Block (andere Zeile) wird ersetzt, nicht verdoppelt.
  sed -i 's/^30 1 \* \* \* /15 4 * * * /' "$FAKE_CRONTAB"
  if tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_installed' >/dev/null 2>&1; then
    test_fail "changed block counted as installed"
  fi
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install' >"$out" 2>&1 || test_fail "reinstall failed"
  assert_contains "$FAKE_CRONTAB" "$line"
  assert_not_contains "$FAKE_CRONTAB" "15 4 * * *"
  [[ "$(grep -c -- '# >>> taxtronik tcms-backup' "$FAKE_CRONTAB")" == "1" ]] || test_fail "block duplicated"
  # Entfernen: nur der Block, eigene Eintraege bleiben; zweites Entfernen ist ein No-op.
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_remove; tcms_backup_schedule_remove' >"$out" 2>&1 || \
    test_fail "remove failed"
  assert_contains "$FAKE_CRONTAB" "0 3 * * * /usr/local/bin/eigener-job"
  assert_not_contains "$FAKE_CRONTAB" "taxtronik tcms-backup"
  assert_not_contains "$FAKE_CRONTAB" "--zeitplan"
  # Nur der Block in der crontab: Entfernen loescht die crontab.
  : >"$FAKE_CRONTAB"
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install; tcms_backup_schedule_remove' >"$out" 2>&1
  [[ ! -s "$FAKE_CRONTAB" ]] || test_fail "remove left a block behind"
  # Nur managed; ohne crontab-Programm keine Aenderung.
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=disabled/' "$env_file"
  if tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install' >"$out" 2>&1; then
    test_fail "schedule installed without managed TCMS"
  fi
  sed -i 's/^TCMS_DEPLOYMENT=disabled$/TCMS_DEPLOYMENT=managed/' "$env_file"
  rm -f "$FAKE_CRONTAB"
  if KEIN_CRONTAB=1 tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install' >"$out" 2>&1; then
    test_fail "install without crontab reported success"
  fi
  assert_contains "$out" "crontab fehlt"
  [[ ! -e "$FAKE_CRONTAB" ]] || test_fail "crontab written without crontab program"
  # Pfade, die cron bzw. /bin/sh anders lesen: abgewiesen statt maskiert.
  local bad
  for bad in "/srv/tax%tronik" "/srv/o'neil" $'/srv/zeile\nzwei' '/srv/back\slash' ""; do
    if tcms_backup_cron_line "$bad" "/tmp/x.log" >/dev/null 2>&1; then test_fail "unsafe path accepted: $bad"; fi
    if tcms_backup_cron_line "/srv/ok" "$bad" >/dev/null 2>&1; then test_fail "unsafe log path accepted: $bad"; fi
  done
  pass "TCMS backup schedule: one managed crontab block, idempotent, replaced when stale, removed alone"
}

test_setup_deploy_and_disable_manage_the_backup_schedule() {
  local env_file="$TMP_DIR/sched-setup.env" out="$TMP_DIR/sched-setup.out" body
  export FAKE_CRONTAB="$TMP_DIR/sched-setup.crontab"
  rm -f "$FAKE_CRONTAB"
  tcms_base_env "$env_file"
  tcms_isolated "$env_file" cmd_tcms_setup managed --no-start </dev/null >"$out" 2>&1 || test_fail "setup managed failed"
  assert_contains "$FAKE_CRONTAB" "./taxtronik tcms backup --zeitplan"
  assert_contains "$out" "TCMS-Sicherung geplant"
  # Abgeschaltet: kein Eintrag, Hinweis auf eigene Planung.
  rm -f "$FAKE_CRONTAB"
  printf 'TCMS_BACKUP_SCHEDULE=off\n' >>"$env_file"
  tcms_isolated "$env_file" eval 'load_env; tcms_ensure_backup_schedule' >"$out" 2>&1 || test_fail "ensure with off failed"
  [[ ! -e "$FAKE_CRONTAB" ]] || test_fail "schedule installed although TCMS_BACKUP_SCHEDULE=off"
  assert_contains "$out" "TCMS_BACKUP_SCHEDULE=off"
  sed -i 's/^TCMS_BACKUP_SCHEDULE=off$/TCMS_BACKUP_SCHEDULE=jaja/' "$env_file"
  tcms_isolated "$env_file" eval 'load_env; tcms_ensure_backup_schedule' >"$out" 2>&1 || test_fail "ensure with invalid value aborted"
  [[ ! -e "$FAKE_CRONTAB" ]] || test_fail "schedule installed with invalid TCMS_BACKUP_SCHEDULE"
  assert_contains "$out" "TCMS_BACKUP_SCHEDULE ist ungueltig"
  sed -i '/^TCMS_BACKUP_SCHEDULE=/d' "$env_file"
  # Fehlendes crontab-Programm bricht deploy/setup nicht ab.
  KEIN_CRONTAB=1 tcms_isolated "$env_file" eval 'load_env; tcms_ensure_backup_schedule' >"$out" 2>&1 || \
    test_fail "missing crontab aborted ensure"
  # Deploy/Update: Zeitplan nach einem gesunden tcms-api; disable entfernt ihn.
  body="$TMP_DIR/start-tcms-deploy.body"; declare -f start_tcms_for_deploy >"$body"
  assert_before "$body" "tcms_restart_api" "tcms_ensure_backup_schedule"
  assert_before "$body" "tcms_ensure_backup_schedule" "warn \"Neuer tcms-api wurde nicht healthy"
  body="$TMP_DIR/cmd-tcms-setup.body"; declare -f cmd_tcms_setup >"$body"
  assert_before "$body" "tcms_configure_managed" "tcms_ensure_backup_schedule"
  tcms_isolated "$env_file" eval 'load_env; tcms_ensure_backup_schedule' >"$out" 2>&1
  assert_contains "$FAKE_CRONTAB" "--zeitplan"
  tcms_isolated "$env_file" eval '
    tcms_installed() { return 1; }
    tcms_remove_containers() { :; }
    load_env; cmd_tcms_disable' >"$out" 2>&1 || test_fail "disable failed"
  assert_not_contains "$FAKE_CRONTAB" "--zeitplan"
  assert_contains "$out" "TCMS-Zeitplan entfernt"
  pass "setup managed and deploy install the TCMS backup schedule (unless off), disable removes it"
}

test_scheduled_tcms_backup_rotates_only_its_directory_and_stamps() {
  local env_file="$TMP_DIR/rot.env" host="$TMP_DIR/rot-host" dir out="$TMP_DIR/rot.out" i name neu
  export CALLS="$TMP_DIR/rot.calls" PSQL_STDIN="$TMP_DIR/rot.stdin" BACKUP_STAMP="$TMP_DIR/rot.stamp"
  managed_env "$env_file"; : >"$CALLS"
  printf 'TCMS_BACKUP_KEEP=3\n' >>"$env_file"
  dir="$host/tcms-zeitplan"
  mkdir -p "$dir"
  # Aeltere Laeufe (Zeitstempel im Namen), eine fremde Datei und manuelle Dumps darueber.
  for i in 1 2 3 4 5; do
    name="tcms-db-2026010$i-013000-abc$i.dump"
    printf 'alt\n' >"$dir/$name"; printf 'x  %s\n' "$name" >"$dir/$name.sha256"
  done
  printf 'eigene Notiz\n' >"$dir/notiz.txt"
  printf 'manuell\n' >"$host/tcms-db-20250101-000000-manu.dump"
  rotation_run() {
    BACKUP_HOST_DIR="$host" tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'
      tcms_now() { printf "%s" "${FAKE_NOW:-1792540800}"; }
      prepare_backup_host_dir() { :; }
      ensure_s3_ready_for_backup() { :; }
      tcms_prepare_db_for_backup() { return 0; }
      upload_tcms_backup() { [[ -z "${FAIL_UPLOAD:-}" ]]; }
      cmd_tcms_backup --zeitplan'
  }
  # Fehlgeschlagener Upload: keine Rotation, kein Stempel.
  if FAIL_UPLOAD=1 rotation_run >"$out" 2>&1; then test_fail "failed upload reported success"; fi
  [[ "$(find "$dir" -name 'tcms-db-*.dump' | wc -l)" == "6" ]] || test_fail "rotation ran after a failed upload"
  [[ ! -e "$BACKUP_STAMP" ]] || test_fail "stamp written after a failed upload"
  # Der Lauf mit gescheitertem Upload hat seinen Dump lokal hinterlassen.
  local ungeladen
  ungeladen="$(find "$dir" -name 'tcms-db-*.dump' ! -name 'tcms-db-2026010*' -printf '%f\n')"
  [[ -n "$ungeladen" ]] || test_fail "dump of the failed upload missing"
  rotation_run >"$out" 2>&1 || { sed -n '1,80p' "$out" >&2; test_fail "scheduled backup failed"; }
  # Neueste 3 Paare bleiben (neuer Lauf, Dump des gescheiterten Uploads, 05), aeltere sind weg.
  neu="$(sed -n 's/^datei=//p' "$BACKUP_STAMP")"
  [[ -f "$dir/$neu" && -f "$dir/$neu.sha256" ]] || test_fail "new dump missing in the schedule directory: $neu"
  [[ "$neu" != "$ungeladen" && -f "$dir/$ungeladen" ]] || test_fail "newer local dump was removed"
  [[ "$(find "$dir" -name 'tcms-db-*.dump' | wc -l)" == "3" ]] || test_fail "rotation kept a wrong number of dumps"
  [[ -f "$dir/tcms-db-20260105-013000-abc5.dump" && -f "$dir/tcms-db-20260105-013000-abc5.dump.sha256" ]] || \
    test_fail "third newest dump was removed"
  for i in 1 2 3 4; do
    [[ ! -e "$dir/tcms-db-2026010$i-013000-abc$i.dump" && ! -e "$dir/tcms-db-2026010$i-013000-abc$i.dump.sha256" ]] || \
      test_fail "old dump $i was kept"
  done
  [[ -f "$dir/notiz.txt" && -f "$host/tcms-db-20250101-000000-manu.dump" ]] || test_fail "rotation touched files outside its pattern or directory"
  # Stempel: Zeitpunkt und Datei, 0600, keine Werte.
  assert_contains "$BACKUP_STAMP" "zeit=1792540800"
  [[ "$(file_mode "$BACKUP_STAMP")" == "600" ]] || test_fail "stamp is not 0600"
  local key
  for key in TCMS_DB_SUPERUSER_PASSWORD TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD TCMS_SERVICE_TOKEN; do
    assert_not_contains "$BACKUP_STAMP" "$(env_value "$env_file" "$key")"
    assert_not_contains "$out" "$(env_value "$env_file" "$key")"
  done
  # Ungueltige Aufbewahrung: Abbruch vor jedem Dump.
  : >"$CALLS"
  sed -i 's/^TCMS_BACKUP_KEEP=3$/TCMS_BACKUP_KEEP=0/' "$env_file"
  if rotation_run >"$out" 2>&1; then test_fail "invalid TCMS_BACKUP_KEEP accepted"; fi
  assert_not_contains "$CALLS" "pg_dump"
  # Ohne --zeitplan: Dump unter backups/, keine Rotation.
  sed -i 's/^TCMS_BACKUP_KEEP=0$/TCMS_BACKUP_KEEP=1/' "$env_file"
  BACKUP_HOST_DIR="$host" tcms_isolated "$env_file" eval "$(tcms_db_docker_stub)"'
    prepare_backup_host_dir() { :; }; ensure_s3_ready_for_backup() { :; }
    tcms_prepare_db_for_backup() { return 0; }; upload_tcms_backup() { return 0; }
    cmd_tcms_backup' >"$out" 2>&1 || test_fail "manual backup failed"
  [[ "$(find "$dir" -name 'tcms-db-*.dump' | wc -l)" == "3" ]] || test_fail "manual backup rotated the schedule directory"
  [[ "$(find "$host" -maxdepth 1 -name 'tcms-db-*.dump' | wc -l)" == "2" ]] || test_fail "manual dump not in backups/"
  pass "scheduled TCMS backup: own directory, newest TCMS_BACKUP_KEEP kept after upload, stamp 0600"
}

# Regel: Der Stempel entsteht atomar (Temp-Datei, 0600, mv). Scheitert ein
# Schritt, meldet die Funktion den Fehler, raeumt die Temp-Datei weg und
# laesst den bisherigen Stempel stehen (doctor misst weiter das echte Alter).
test_tcms_backup_stamp_is_written_atomically_or_not_at_all() {
  local dir="$TMP_DIR/stamp-atomar" schritt rest
  mkdir -p "$dir"
  stempel_schreiben() {
    (
      TCMS_BACKUP_STAMP="$dir/stamp"
      tcms_now() { printf '1792540800'; }
      case "$1" in
        chmod) chmod() { return 1; } ;;
        mv) mv() { return 1; } ;;
        printf) TCMS_BACKUP_STAMP="$dir/fehlt/stamp" ;;
      esac
      tcms_backup_stamp_write "/irgendwo/tcms-db-neu.dump"
    )
  }
  ( umask 0022; stempel_schreiben ok ) || test_fail "stamp write failed"
  assert_contains "$dir/stamp" "zeit=1792540800"
  assert_contains "$dir/stamp" "datei=tcms-db-neu.dump"
  [[ "$(file_mode "$dir/stamp")" == "600" ]] || test_fail "stamp is not 0600 under umask 022"
  printf 'zeit=1700000000\ndatei=tcms-db-alt.dump\n' >"$dir/stamp"
  for schritt in chmod mv printf; do
    if stempel_schreiben "$schritt"; then test_fail "stamp write reported success although $schritt failed"; fi
    rest="$(find "$dir" -name 'stamp.tmp.*' | wc -l)"
    [[ "$rest" == "0" ]] || test_fail "temporary stamp left behind after a failed $schritt"
    assert_contains "$dir/stamp" "zeit=1700000000"
  done
  pass "TCMS backup stamp is written atomically with 0600 or not at all"
}

test_doctor_checks_tcms_backup_schedule_and_age() {
  local env_file="$TMP_DIR/doc-bak.env" out="$TMP_DIR/doc-bak.out" jetzt=1792540800
  export FAKE_CRONTAB="$TMP_DIR/doc-bak.crontab" BACKUP_STAMP="$TMP_DIR/doc-bak.stamp"
  managed_env "$env_file"; rm -f "$FAKE_CRONTAB" "$BACKUP_STAMP"
  doctor_run() {
    run_tcms_doctor "$env_file" "$out" 'docker() { return 1; }; tcms_now() { printf "%s" '"$jetzt"'; }'
  }
  stempel() { printf 'zeit=%s\ndatei=tcms-db-x.dump\n' "$1" >"$BACKUP_STAMP"; }
  doctor_run
  assert_contains "$out" "WARN     TCMS_BACKUP_ZEITPLAN"
  assert_contains "$out" "WARN     TCMS_BACKUP            keine erfolgreiche TCMS-Sicherung"
  tcms_isolated "$env_file" eval 'load_env; tcms_backup_schedule_install' >/dev/null 2>&1
  stempel $((jetzt - 3600))
  doctor_run
  assert_contains "$out" "OK       TCMS_BACKUP_ZEITPLAN"
  assert_contains "$out" "OK       TCMS_BACKUP "
  # Grenze 26 h wie der Staleness-Alarm der Hauptdatenbank.
  stempel $((jetzt - 26 * 3600))
  doctor_run
  assert_contains "$out" "OK       TCMS_BACKUP "
  stempel $((jetzt - 26 * 3600 - 1))
  doctor_run
  assert_contains "$out" "WARN     TCMS_BACKUP            letzte Sicherung"
  assert_contains "$out" "aelter als 26 h"
  printf 'zeit=bald\n' >"$BACKUP_STAMP"
  doctor_run
  assert_contains "$out" "keine erfolgreiche TCMS-Sicherung"
  # Zeitplan veraltet bzw. crontab fehlt bzw. bewusst abgeschaltet.
  sed -i 's/^30 1 /45 2 /' "$FAKE_CRONTAB"
  doctor_run
  assert_contains "$out" "WARN     TCMS_BACKUP_ZEITPLAN   fehlt oder veraltet"
  KEIN_CRONTAB=1 doctor_run
  assert_contains "$out" "crontab fehlt"
  printf 'TCMS_BACKUP_SCHEDULE=off\n' >>"$env_file"
  doctor_run
  assert_contains "$out" "INFO     TCMS_BACKUP_ZEITPLAN   abgeschaltet"
  # Nicht verwaltet: keine Sicherungszeilen.
  sed -i 's/^TCMS_DEPLOYMENT=managed$/TCMS_DEPLOYMENT=disabled/' "$env_file"
  sed -i -E 's/^(TCMS_URL|TCMS_SERVICE_TOKEN|TCMS_ACTOR_PRIVATE_KEY|TCMS_ACTOR_KEY_ID)=.*/\1=/' "$env_file"
  doctor_run
  assert_not_contains "$out" "TCMS_BACKUP"
  pass "doctor: TCMS backup schedule present and last backup not older than 26 h"
}

run_test test_tcms_mode_defaults_to_disabled_and_rejects_unknown_values
run_test test_compose_loads_tcms_file_only_when_managed
run_test test_compose_writer_guard_sees_subcommand_after_global_options
run_test test_release_pins_are_read_strictly_from_a_commit
run_test test_registry_compose_requires_signed_tcms_pins
run_test test_managed_setup_generates_contract_conform_secrets_once
run_test test_code_key_setup_is_idempotent_resumable_and_strict
run_test test_update_adds_a_missing_code_key_and_warns_once
run_test test_new_service_tokens_avoid_the_code_key
run_test test_setup_and_rotation_never_expose_secrets
run_test test_token_rotation_overlaps_and_retires_the_old_token
run_test test_key_rotation_waits_five_minutes_before_removing_the_old_key
run_test test_rotation_resumes_after_interruptions
run_test test_code_key_rotation_keeps_the_old_key_for_seven_days
run_test test_code_key_rotation_resumes_and_forces_only_with_the_word
run_test test_code_key_rotation_state_and_refusals
run_test test_code_key_rotation_publish_refuses_a_list_that_does_not_match_the_state
run_test test_new_code_keys_are_43_char_base64url_and_valid
run_test test_rotation_refuses_inconsistent_or_unmanaged_configuration
run_test test_external_setup_requires_https_and_prints_only_the_public_key
run_test test_disable_restarts_writers_first_and_keeps_the_database_volume
run_test test_configure_tcms_for_env_persists_disabled_and_fills_only_gaps
run_test test_doctor_checks_tcms_formats_without_printing_values
run_test test_doctor_and_status_check_the_code_key_without_values
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
run_test test_full_backup_keeps_env_and_a_running_code_key_rotation
run_test test_tcms_restore_validates_before_side_effects
run_test test_tcms_restore_restores_roles_then_data_then_migrates
run_test test_tcms_backup_schedule_installs_idempotently_and_keeps_other_entries
run_test test_setup_deploy_and_disable_manage_the_backup_schedule
run_test test_scheduled_tcms_backup_rotates_only_its_directory_and_stamps
run_test test_tcms_backup_stamp_is_written_atomically_or_not_at_all
run_test test_doctor_checks_tcms_backup_schedule_and_age

if (( TESTS_FAILED > 0 )); then
  printf '\n%s ops-tcms tests failed, %s passed:\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  printf '  not ok - %s\n' "${FAILED_TESTS[@]}" >&2
  exit 1
fi
printf '\n%s ops-tcms tests passed.\n' "$TESTS_RUN"
