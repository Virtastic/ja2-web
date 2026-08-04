#!/usr/bin/env bash
# Push the local working tree to the build server. Run from anywhere in the repo.
#
# The build server does NOT use git: this lets uncommitted work build exactly as it sits on
# disk (the whole point of a test server). Source arrives by rsync over the LAN.
set -euo pipefail

_cfg="$(dirname "$0")/config.env"
# shellcheck disable=SC1090
[ -f "$_cfg" ] && . "$_cfg"
BUILDER="${BUILDER:?set BUILDER in ci/jenkins/config.env (see config.env.example)}"
DEST="${DEST:-ja2-src}"

cd "$(dirname "$0")/../.."   # repo root
command -v rsync >/dev/null || { echo "rsync not found"; exit 1; }

echo "==> syncing working tree to $BUILDER:$DEST"
# Excludes mirror .dockerignore + the local-only heavy/generated trees. fsroot/ (externalized
# + mods, the small preload) IS sent; the commercial game data and build outputs are not.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'build-wasm/' --exclude 'source-ja2/build*/' \
  --exclude 'gamedata-src/' --exclude 'gamedata-lean/' --exclude 'fsroot/gamedata/' \
  --exclude 'play/ja2.js' --exclude 'play/ja2.wasm' --exclude 'play/ja2.data' \
  --exclude 'play/ja2-gamedata.*' --exclude 'play/ja2-lean.*' --exclude 'play/testdata' \
  --exclude '*.br' \
  --exclude 'node_modules/' --exclude 'cloud/node_modules/' \
  --exclude 'wasm-build/smoke/' --exclude 'wasm-build/smoke2/' --exclude 'wasm-build/fltk*' \
  --exclude 'source-ja2/dependencies/lib-SDL2-2.0.20-*/' \
  --exclude 'infra/terraform/.terraform/' --exclude 'infra/terraform/*.tfstate*' \
  ./ "$BUILDER:$DEST/"

# Record the commit for traceability even though the tree isn't a git checkout on the builder.
git rev-parse HEAD 2>/dev/null | ssh "$BUILDER" "cat > $DEST/.source-commit" || true
echo "==> synced ($(git rev-parse --short HEAD 2>/dev/null || echo dirty))"
