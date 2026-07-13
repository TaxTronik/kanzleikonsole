#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$SCRIPT_DIR/verify-tag-checkout.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  printf 'not ok - %s\n' "$*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift
  local out="$TMP_DIR/failure.out"
  if "$@" >"$out" 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq "$expected" "$out" || {
    cat "$out" >&2
    fail "failure did not contain: $expected"
  }
}

git -C "$TMP_DIR" init -q
git -C "$TMP_DIR" config user.name release-gate-test
git -C "$TMP_DIR" config user.email release-gate@example.invalid
printf 'first\n' >"$TMP_DIR/content.txt"
git -C "$TMP_DIR" add content.txt
git -C "$TMP_DIR" commit -qm first
first_sha="$(git -C "$TMP_DIR" rev-parse HEAD)"
base_branch="$(git -C "$TMP_DIR" symbolic-ref --short HEAD)"
git -C "$TMP_DIR" tag -a v1.2.3 -m release

(
  cd "$TMP_DIR"
  GITHUB_SHA="$first_sha" GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 \
    RELEASE_BASE_REF="$base_branch" \
    sh "$VERIFY"
) >/dev/null
printf 'ok 1 - exact annotated release tag is accepted\n'

expect_failure 'striktes vMAJOR.MINOR.PATCH' env \
  GITHUB_SHA="$first_sha" GITHUB_REF=refs/tags/latest GITHUB_REF_NAME=latest \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 2 - non-semver tag is rejected\n'

expect_failure 'kein exakter Release-Tag' env \
  GITHUB_SHA="$first_sha" GITHUB_REF=refs/heads/main GITHUB_REF_NAME=v1.2.3 \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 3 - branch event is rejected\n'

printf 'second\n' >>"$TMP_DIR/content.txt"
git -C "$TMP_DIR" add content.txt
git -C "$TMP_DIR" commit -qm second
second_sha="$(git -C "$TMP_DIR" rev-parse HEAD)"

expect_failure 'Checkout (' env \
  GITHUB_SHA="$first_sha" GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 4 - checkout/event SHA mismatch is rejected\n'

expect_failure 'statt auf den Event-Commit' env \
  GITHUB_SHA="$second_sha" GITHUB_REF=refs/tags/v1.2.3 GITHUB_REF_NAME=v1.2.3 \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 5 - tag/event SHA mismatch is rejected\n'

git -C "$TMP_DIR" tag v1.2.4
expect_failure 'muss annotiert sein' env \
  GITHUB_SHA="$second_sha" GITHUB_REF=refs/tags/v1.2.4 GITHUB_REF_NAME=v1.2.4 \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 6 - lightweight release tag is rejected\n'

git -C "$TMP_DIR" switch -qc release-side "$first_sha"
printf 'side\n' >>"$TMP_DIR/content.txt"
git -C "$TMP_DIR" add content.txt
git -C "$TMP_DIR" commit -qm side
side_sha="$(git -C "$TMP_DIR" rev-parse HEAD)"
git -C "$TMP_DIR" tag -a v2.0.0 -m side-release
expect_failure 'ist nicht Bestandteil der Freigabe-Basis' env \
  GITHUB_SHA="$side_sha" GITHUB_REF=refs/tags/v2.0.0 GITHUB_REF_NAME=v2.0.0 \
  RELEASE_BASE_REF="$base_branch" \
  sh -c "cd '$TMP_DIR' && '$VERIFY'"
printf 'ok 7 - tag outside the release base branch is rejected\n'
