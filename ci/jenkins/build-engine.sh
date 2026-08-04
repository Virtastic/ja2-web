#!/usr/bin/env bash
# Build the ja2-web image ON the build server (run there, in the synced source dir).
# First run bootstraps ja2-builder:1 (emscripten 6.0.1 + Rust nightly) - slow, one-time.
set -euo pipefail

SRC="${SRC:-$HOME/ja2-src}"
TAG="${TAG:-ja2:test}"
cd "$SRC"

[ -f Dockerfile ]         || { echo "FATAL: no Dockerfile in $SRC (sync first)"; exit 1; }
[ -f Dockerfile.builder ] || { echo "FATAL: no Dockerfile.builder in $SRC"; exit 1; }
[ -d fsroot/externalized ] || { echo "FATAL: fsroot/externalized missing (sync problem)"; exit 1; }

# Bootstrap the toolchain image if absent. --network=host: rustup + the wasm target need egress
# the default build bridge lacks. Mirrors .github/workflows/deploy-ovh.yml.
docker image inspect ja2-builder:1 >/dev/null 2>&1 || {
  echo "==> ja2-builder:1 missing - building it (one-time, ~20-40 min)"
  DOCKER_BUILDKIT=1 docker build --network=host -t ja2-builder:1 -f Dockerfile.builder .
}

echo "==> building $TAG from $(cat .source-commit 2>/dev/null || echo 'dirty tree')"
DOCKER_BUILDKIT=1 docker build --network=host -t "$TAG" -f Dockerfile .
echo "==> built $TAG"
docker image inspect "$TAG" --format '    size: {{.Size}} bytes  created: {{.Created}}'
