#!/bin/sh
# Content-version the built engine so a CDN can NEVER serve a mismatched mix of two builds' files.
# The engine is three files loaded as one set: <name>.js (loader) + <name>.wasm (code) + <name>.data
# (preload), all with stable names. Cloudflare caches each independently, so across redeploys a browser
# could get <name>.js from build A but <name>.wasm from build B → a mismatched loader/wasm pair calls
# unlinked function pointers → "RuntimeError: null function" at boot.
#
# Fix: hash <name>.wasm, move <name>.{js,wasm,data} (and their .gz/.br siblings) into <play>/e/<hash>/,
# and stamp that hash into <play>/index.html (Module.locateFile resolves the wasm/data/worker from the
# same dir; the .gz/.br stay beside their raw file for nginx gzip_static / Caddy precompressed). Every
# build lives at a UNIQUE path so a mismatch is impossible. index.html is no-cache → always current.
# Run AFTER the build. Usage: NAME=ja2 PLAY=/usr/share/nginx/html sh version-engine.sh
set -eu
NAME="${NAME:-ja2}"
PLAY="${PLAY:-${1:-play}}"
cd "$PLAY"
[ -f "$NAME.wasm" ] || { echo "version-engine: $NAME.wasm not found in $PLAY" >&2; exit 1; }
VER=$( { sha256sum "$NAME.wasm" 2>/dev/null || shasum -a 256 "$NAME.wasm"; } | cut -c1-12 )
[ -n "$VER" ] || { echo "version-engine: could not hash $NAME.wasm" >&2; exit 1; }
DIR="e/$VER"
mkdir -p "$DIR"
for f in "$NAME.js" "$NAME.wasm" "$NAME.data" \
         "$NAME.js.gz" "$NAME.wasm.gz" "$NAME.data.gz" \
         "$NAME.js.br" "$NAME.wasm.br" "$NAME.data.br"; do
  [ -f "$f" ] && mv -f "$f" "$DIR/$f" || true
done
sed "s/__ENGINE_VERSION__/$VER/g" index.html > index.html.tmp && mv index.html.tmp index.html
echo "version-engine: $NAME engine -> $PLAY/$DIR ; index.html stamped ($VER)"
