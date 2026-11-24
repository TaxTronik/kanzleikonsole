#!/usr/bin/env bash
# Derselbe gepinnte Scanner für Service- und Release-Images.
set -euo pipefail
TRIVY_IMAGE=aquasec/trivy:latest@sha256:6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6
TRIVY_BIN="$RUNNER_TEMP/trivy"
TRIVY_CONTAINER="$(docker create "$TRIVY_IMAGE")"
trap 'docker rm -fv "$TRIVY_CONTAINER" >/dev/null 2>&1 || true' EXIT
docker cp "$TRIVY_CONTAINER:/usr/local/bin/trivy" "$TRIVY_BIN"
chmod 0755 "$TRIVY_BIN"
docker rm -v "$TRIVY_CONTAINER" >/dev/null
trap - EXIT

if [ -n "${DOCKER_HOST:-}" ]; then
  TRIVY_DOCKER_HOST="$DOCKER_HOST"
else
  TRIVY_DOCKER_HOST="$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')"
fi
test -n "$TRIVY_DOCKER_HOST"
"$TRIVY_BIN" --version
{
  echo "TRIVY_BIN=$TRIVY_BIN"
  echo "TRIVY_DOCKER_HOST=$TRIVY_DOCKER_HOST"
} >> "$GITHUB_ENV"
