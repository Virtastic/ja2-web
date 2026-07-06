#!/bin/bash
# Copy a JA2 install's Data folder into fsroot and repack the wasm data bundle.
# Usage: bundle-data.sh [path-to-ja2-install]   (default: ~/ja2steam)
set -e
SRC="${1:-$HOME/ja2steam}"
. "$(dirname "$0")/env.sh"
DATA_DIR=""
for d in "$SRC/Data" "$SRC/data"; do [ -d "$d" ] && DATA_DIR="$d" && break; done
[ -n "$DATA_DIR" ] || { echo "No Data dir under $SRC"; exit 1; }
echo "Using $DATA_DIR"
mkdir -p "$JA2WEB_ROOT/gamedata-src/gamedata/data"
rsync -a --delete "$DATA_DIR/" "$JA2WEB_ROOT/gamedata-src/gamedata/data/"
du -sh "$JA2WEB_ROOT/gamedata-src/gamedata"
# Repackage the standalone game-data package (no relink needed).
"$(dirname "$0")/package-data.sh"
echo "Done — reload the browser page."
