#!/bin/bash
# Helper: drive the headless harness. Usage:
#   drive.sh click X Y        click and print title
#   drive.sh shot FILE        screenshot
#   drive.sh title            print title
#   drive.sh ls KEY           print localStorage key
#   drive.sh seq "X Y" "X Y" ...   click a sequence with 1.5s between, print title after each
cd "$(dirname "$0")/.."
H="node wasm-build/harness.mjs"
case "$1" in
  click) $H click "$2" "$3" >/dev/null 2>&1; sleep 1.5; echo "click $2 $3 -> $($H title 2>/dev/null || echo DEAD)";;
  shot)  $H shot "$2";;
  title) $H title 2>/dev/null || echo DEAD;;
  ls)    $H ls "$2" 2>/dev/null;;
  seq)   shift; for pair in "$@"; do set -- $pair; $H click "$1" "$2" >/dev/null 2>&1; sleep 1.8; echo "click $1 $2 -> $($H title 2>/dev/null || echo DEAD)"; done;;
  *) echo "unknown $1";;
esac
