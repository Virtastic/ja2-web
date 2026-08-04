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
NAME="${NAME:-ja2-test}"
PORT="${PORT:-8081}"
SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

echo "==> shipping $TAG to $TEST_HOST"
docker save "$TAG" | $SSH "$TEST_HOST" 'docker load'

echo "==> (re)starting $NAME on :$PORT"
# The ja2 image is self-contained: nginx + infra/nginx.conf, which already sets COOP/COEP/CORP.
# The nginx-proxy-manager in front routes ja2.dev.virtastic.app -> TEST_HOST:PORT (TLS/SNI there).
$SSH "$TEST_HOST" "
  set -e
  docker rm -f $NAME >/dev/null 2>&1 || true
  docker run -d --name $NAME --restart unless-stopped -p ${PORT}:80 $TAG >/dev/null
"

echo "==> health check on the container"
for i in $(seq 1 30); do
  code=$($SSH "$TEST_HOST" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/" || echo 000)
  hdr=$($SSH "$TEST_HOST" "curl -s -I http://localhost:${PORT}/ | grep -i cross-origin-opener" || true)
  if [ "$code" = "200" ] && [ -n "$hdr" ]; then
    echo "    $NAME healthy (HTTP $code, cross-origin-isolated) on :$PORT"; exit 0
  fi
  sleep 2
done
echo "FATAL: $NAME did not become healthy on :$PORT"
$SSH "$TEST_HOST" "docker logs --tail 30 $NAME" || true
exit 1
