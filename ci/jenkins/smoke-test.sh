#!/usr/bin/env bash
# Post-deploy contract test against a DEPLOYED ja2-web origin. A 200 proves little - assert the
# serving contract a player actually needs. Intentionally curl-only so it runs against anything.
#
# Usage: smoke-test.sh <base-url>
set -uo pipefail
BASE="${1:?usage: smoke-test.sh <base-url>}"; BASE="${BASE%/}"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }
get()  { curl -s --max-time 20 "$@"; }
hdrs() { curl -s -D - -o /dev/null --max-time 20 "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
# has <pattern> <string>: case-insensitive contains, via here-string. NEVER `echo "$big" | grep -q`
# under `set -o pipefail`: grep -q exits on first match, echo gets SIGPIPE, and the pipeline reports
# failure despite the match (bites only once the body exceeds the pipe buffer).
has()  { grep -qi -- "$1" <<<"$2"; }

echo "==> ja2-web serving contract: $BASE"

# 1. Cross-origin isolation - the engine refuses to start (SharedArrayBuffer) without BOTH.
H="$(hdrs "$BASE/")"
has '^cross-origin-opener-policy: *same-origin'   "$H" && pass "COOP: same-origin"   || fail "COOP header" "SharedArrayBuffer will be unavailable"
has '^cross-origin-embedder-policy: *require-corp' "$H" && pass "COEP: require-corp" || fail "COEP header" "cross-origin isolation off"

# 2. The root serves the launcher (data chooser), not a raw 404 / directory listing.
B="$(get "$BASE/")"
has 'Jagged Alliance' "$B" && pass "root serves the launcher" || fail "launcher at /" "root did not return the JA2 launcher"

# 3. The engine artifacts are present and typed correctly. The engine is content-versioned: the build
#    stamps  var __ENGINE_VER = "<hash>"  into index.html and moves ja2.{js,wasm,data} to e/<hash>/.
#    The page builds the path at runtime ("e/"+VER+"/"), so we read the hash rather than assume a path.
IDX="$(get "$BASE/index.html")"
VER="$(grep -oE '__ENGINE_VER *= *"[a-f0-9]+"' <<<"$IDX" | grep -oE '[a-f0-9]{6,}' | head -1)"
if [ -z "$VER" ]; then
  fail "engine version" "no __ENGINE_VER hash found in index.html (versioning step didn't run?)"
else
  E="e/$VER/"
  [ "$(code "$BASE/${E}ja2.js")" = 200 ]   && pass "engine ja2.js served ($E)" || fail "ja2.js" "engine loader missing at $E"
  [ "$(code "$BASE/${E}ja2.wasm")" = 200 ] && pass "engine ja2.wasm served"     || fail "ja2.wasm" "engine wasm missing at $E"
  has '^content-type: *application/wasm' "$(hdrs "$BASE/${E}ja2.wasm")" && pass "ja2.wasm is application/wasm" || fail "wasm mime" "wrong Content-Type"
fi

# 4. Upload-only test build: the bundled game data is deliberately absent (bring-your-own / cloud).
[ "$(code "$BASE/ja2-gamedata.data")" = 404 ] && pass "no bundled game data (upload-only)" || fail "game data leak" "commercial data should not be served on the test build"

echo
[ "$FAILED" = 0 ] && { echo "==> contract OK"; exit 0; } || { echo "==> $FAILED contract failure(s)"; exit 1; }
