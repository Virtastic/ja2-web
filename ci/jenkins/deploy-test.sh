#!/usr/bin/env bash
# Ship the built image from the build server to the test app server and (re)start it there.
# Run ON the build server (it holds ja2:test and can ssh the test host). No registry:
# `docker save | ssh docker load` over the LAN is fast enough and one less moving part.
set -euo pipefail

_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
TEST_HOST="${TEST_HOST:?set TEST_HOST in ci/jenkins/config.env}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
TAG="${TAG:-ja2:test}"
CLOUD_TAG="${CLOUD_TAG:-ja2-cloud:${TAG#*:}}"
NAME="${NAME:-ja2-test}"
NET="${NET:-ja2net}"
PORT="${PORT:-8081}"
# Test-only: local storage (no S3), dev-auth on so the Cloud tile is fully demoable, and a fixed
# BASE_URL for cookie/redirect correctness behind the proxy. A throwaway JWT secret is fine here.
BASE_URL="${SMOKE_URL:-https://ja2.dev.virtastic.app}"
SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

echo "==> shipping $TAG + $CLOUD_TAG to $TEST_HOST"
docker save "$TAG" "$CLOUD_TAG" | $SSH "$TEST_HOST" 'docker load'

echo "==> (re)starting $NAME (+ ja2-cloud) on :$PORT"
# nginx (in $NAME) proxies /api/ -> ja2-cloud:8080 over the user-defined network $NET (Docker DNS).
# The nginx-proxy-manager in front routes ja2.dev.virtastic.app -> TEST_HOST:PORT (TLS/SNI there).
$SSH "$TEST_HOST" "
  set -e
  docker network create $NET >/dev/null 2>&1 || true
  docker rm -f $NAME ja2-cloud >/dev/null 2>&1 || true
  docker run -d --name ja2-cloud --network $NET --restart unless-stopped \
    -e DEV_AUTH=1 -e DATA_DIR=/data -e JWT_SECRET=test-ja2-dev-secret -e BASE_URL='$BASE_URL' \
    -v ja2-cloud-data:/data $CLOUD_TAG >/dev/null
  docker run -d --name $NAME --network $NET --restart unless-stopped -p ${PORT}:80 $TAG >/dev/null
"

echo "==> health check on the container"
for i in $(seq 1 30); do
  code=$($SSH "$TEST_HOST" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/" || echo 000)
  hdr=$($SSH "$TEST_HOST" "curl -s -I http://localhost:${PORT}/ | grep -i cross-origin-opener" || true)
  if [ "$code" = "200" ] && [ -n "$hdr" ]; then
    echo "    $NAME healthy (HTTP $code, cross-origin-isolated) on :$PORT"
    api=$($SSH "$TEST_HOST" "curl -s http://localhost:${PORT}/api/health" || true)
    case "$api" in *'"ok":true'*) echo "    Cloud Locker API up: $api" ;; *) echo "    WARN: /api/health not responding yet: ${api:-<none>}" ;; esac
    exit 0
  fi
  sleep 2
done
echo "FATAL: $NAME did not become healthy on :$PORT"
$SSH "$TEST_HOST" "docker logs --tail 30 $NAME" || true
exit 1
