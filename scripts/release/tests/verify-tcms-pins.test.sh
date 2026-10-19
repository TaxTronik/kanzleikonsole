#!/usr/bin/env bash
# Tests fuer scripts/release/verify-tcms-pins.sh (TCMS Stufe 2). docker ist
# eine Attrappe: protokolliert die Aufrufe, antwortet mit FAKE_LABEL und
# scheitert beim Pull, wenn FAKE_PULL_FAIL gesetzt ist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$SCRIPT_DIR/verify-tcms-pins.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

API="sha256:$(printf '1%.0s' {1..64})"
MIGRATE="sha256:$(printf '2%.0s' {1..64})"
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/repo/infra/compose"
cat >"$TMP_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$1" in
  pull) [[ -z "${FAKE_PULL_FAIL:-}" ]] ;;
  image) printf '%s\n' "${FAKE_LABEL:-}" ;;
esac
DOCKER
chmod +x "$TMP_DIR/bin/docker"
export DOCKER_CALLS="$TMP_DIR/docker.calls"
git -C "$TMP_DIR/repo" init -q
git -C "$TMP_DIR/repo" config user.name release-gate-test
git -C "$TMP_DIR/repo" config user.email release-gate@example.invalid

commit_pins() {
  printf 'TCMS_RELEASE_VERSION=%s\nTCMS_RELEASE_API_DIGEST=%s\nTCMS_RELEASE_MIGRATE_DIGEST=%s\n' "$1" "$2" "$3" \
    >"$TMP_DIR/repo/infra/compose/tcms-release.env"
  git -C "$TMP_DIR/repo" add infra/compose/tcms-release.env
  git -C "$TMP_DIR/repo" commit -qm pins --allow-empty
  git -C "$TMP_DIR/repo" rev-parse HEAD
}

run_verify() {
  PATH="$TMP_DIR/bin:$PATH" bash "$VERIFY" --prefix registry.example/taxtronik --repo "$TMP_DIR/repo" "$@"
}

# 1) Leere Pins: Gate besteht ohne Registry-Zugriff.
: >"$DOCKER_CALLS"
commit_pins "" "" "" >/dev/null
run_verify >"$TMP_DIR/out" 2>&1 || { cat "$TMP_DIR/out" >&2; fail "empty pins failed"; }
[[ ! -s "$DOCKER_CALLS" ]] || fail "empty pins contacted the registry"
printf 'ok 1 - no TCMS release pinned: gate passes without registry access\n'

# 2) Pins: Pull genau per Digest, Label passt.
: >"$DOCKER_CALLS"
commit_pins 1.2.3 "$API" "$MIGRATE" >/dev/null
FAKE_LABEL=1.2.3 run_verify >"$TMP_DIR/out" 2>&1 || { cat "$TMP_DIR/out" >&2; fail "valid pins failed"; }
grep -Fqx "pull registry.example/taxtronik/tcms-api:1.2.3@$API" "$DOCKER_CALLS" || fail "api not pulled by digest"
grep -Fqx "pull registry.example/taxtronik/tcms-migrate:1.2.3@$MIGRATE" "$DOCKER_CALLS" || fail "migrate not pulled by digest"
printf 'ok 2 - pinned images are pulled by digest and their version label is checked\n'

# 3) Falsches Label, fehlendes Image, ungueltige Pins, alter Commit.
if FAKE_LABEL=1.2.4 run_verify >"$TMP_DIR/out" 2>&1; then fail "wrong version label accepted"; fi
grep -Fq "traegt version=1.2.4" "$TMP_DIR/out" || fail "label error not reported"
if FAKE_LABEL=1.2.3 FAKE_PULL_FAIL=1 run_verify >"$TMP_DIR/out" 2>&1; then fail "missing image accepted"; fi
old="$(git -C "$TMP_DIR/repo" rev-parse HEAD)"
commit_pins 1.2.3 "$API" "$API" >/dev/null
if FAKE_LABEL=1.2.3 run_verify >"$TMP_DIR/out" 2>&1; then fail "identical digests accepted"; fi
FAKE_LABEL=1.2.3 run_verify --commit "$old" >"$TMP_DIR/out" 2>&1 || fail "explicit commit not used"
if run_verify --prefix 'Registry/Unsinn' >"$TMP_DIR/out" 2>&1; then fail "invalid prefix accepted"; fi
printf 'ok 3 - wrong labels, missing images, invalid pins and prefixes stop the gate\n'
printf '\n3 verify-tcms-pins tests passed.\n'
