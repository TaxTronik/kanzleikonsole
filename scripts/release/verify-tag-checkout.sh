#!/usr/bin/env sh
set -eu

fail() {
  printf 'RELEASE-GATE FEHLER: %s\n' "$*" >&2
  exit 1
}

: "${GITHUB_SHA:?GITHUB_SHA fehlt}"
: "${GITHUB_REF:?GITHUB_REF fehlt}"
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME fehlt}"
: "${RELEASE_BASE_REF:?RELEASE_BASE_REF fehlt}"

printf '%s\n' "$GITHUB_REF_NAME" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
  fail "Release-Tag muss striktes vMAJOR.MINOR.PATCH sein: $GITHUB_REF_NAME"

[ "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME" ] ||
  fail "Workflow-Ref ist kein exakter Release-Tag: $GITHUB_REF"

tag_type="$(git cat-file -t "refs/tags/$GITHUB_REF_NAME" 2>/dev/null)" ||
  fail "Release-Tag ist im Checkout nicht vorhanden: $GITHUB_REF_NAME"
[ "$tag_type" = 'tag' ] ||
  fail "Release-Tag muss annotiert sein: $GITHUB_REF_NAME"

head_commit="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
  fail 'HEAD ist kein Commit'
event_commit="$(git rev-parse --verify "${GITHUB_SHA}^{commit}" 2>/dev/null)" ||
  fail "Event-SHA ist kein Commit: $GITHUB_SHA"
tag_commit="$(git rev-parse --verify "refs/tags/${GITHUB_REF_NAME}^{commit}" 2>/dev/null)" ||
  fail "Release-Tag ist im Checkout nicht vorhanden: $GITHUB_REF_NAME"
base_commit="$(git rev-parse --verify "${RELEASE_BASE_REF}^{commit}" 2>/dev/null)" ||
  fail "Freigabe-Basis ist nicht vorhanden: $RELEASE_BASE_REF"

[ "$head_commit" = "$event_commit" ] ||
  fail "Checkout ($head_commit) entspricht nicht dem Event-Commit ($event_commit)"
[ "$tag_commit" = "$event_commit" ] ||
  fail "Tag $GITHUB_REF_NAME zeigt auf $tag_commit statt auf den Event-Commit $event_commit"
git merge-base --is-ancestor "$event_commit" "$base_commit" ||
  fail "Tag-Commit $event_commit ist nicht Bestandteil der Freigabe-Basis $RELEASE_BASE_REF ($base_commit)"

printf 'Release-Ref verifiziert: %s -> %s (Basis %s)\n' \
  "$GITHUB_REF_NAME" "$event_commit" "$RELEASE_BASE_REF"
