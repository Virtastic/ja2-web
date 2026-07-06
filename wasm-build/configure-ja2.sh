#!/bin/bash
set -e
. "$(dirname "$0")/env.sh"
cd "$JA2WEB_ROOT"
emcmake cmake -S source-ja2 -B build-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DWITH_UNITTESTS=OFF \
  -DBUILD_LAUNCHER=OFF \
  -DWITH_RUST_BINARIES=OFF \
  -DWITH_EDITOR_SLF=OFF \
  -DEXTRA_DATA_DIR=/game \
  -DCMAKE_C_FLAGS="$JA2_COMMON_FLAGS" \
  -DCMAKE_CXX_FLAGS="$JA2_COMMON_FLAGS" \
  -DJA2_WASM_LINK_FLAGS="$JA2_LINK_FLAGS" \
  "$@"
