#!/bin/bash
# Package the large JA2 game data (fsroot/gamedata) as a standalone emscripten
# preload package loaded at runtime, decoupled from the wasm link so relinks
# stay fast. Produces play/ja2-gamedata.data + play/ja2-gamedata.js.
# The loader hooks Module.addRunDependency, so it must be included in the page
# BEFORE ja2.js and AFTER `var Module = {...}`.
set -e
. "$(dirname "$0")/env.sh"
cd "$JA2WEB_ROOT"
[ -d gamedata-src/gamedata/data ] || { echo "gamedata-src/gamedata/data missing - run bundle-data.sh first"; exit 1; }
FILE_PACKAGER="$(dirname "$(which emcc)")/tools/file_packager.py"
[ -f "$FILE_PACKAGER" ] || FILE_PACKAGER="$(em-config EMSCRIPTEN_ROOT 2>/dev/null)/tools/file_packager.py"
python3 "$FILE_PACKAGER" play/ja2-gamedata.data \
  --preload "gamedata-src/gamedata@/game/gamedata" \
  --js-output=play/ja2-gamedata.js \
  --no-node --export-name=Module
ls -lh play/ja2-gamedata.data play/ja2-gamedata.js
