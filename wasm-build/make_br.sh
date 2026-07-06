#!/bin/bash
# Precompress wasm/js/data artifacts with brotli for production serving
# (nginx serves .br siblings with Content-Encoding: br).
set -e
cd "$(dirname "$0")/../play"
for f in ja2.wasm ja2.js ja2.data; do
  [ -f "$f" ] || continue
  echo "brotli $f ..."
  brotli -f -q 9 -o "$f.br" "$(readlink "$f" || echo "$f")"
done
ls -lh ja2.*.br 2>/dev/null || true
