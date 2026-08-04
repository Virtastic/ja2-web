#!/usr/bin/env bash
# Abuse/limits test for the Cloud Locker API. Runs the server on a scratch DATA_DIR with SMALL
# limits, then attacks it the way a hostile signed-in user would: oversized bodies, lying
# Content-Length, other users' prefixes, path traversal, non-game file types, quota exhaustion.
# A pass here means the server - not the launcher UI - is what stops the abuse.
#
# Usage: cloud/test-abuse.sh [node-binary]
set -uo pipefail
NODE="${1:-$(command -v node)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; PORT=8137; B="http://127.0.0.1:$PORT"; J="$TMP/jar"
FAILED=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; FAILED=$((FAILED+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -b "$J" "$@"; }
jsonp() { curl -s -b "$J" -X POST -H 'content-type: application/json' -d "$2" "$B$1"; }

# Small limits so the test is fast: 1 MB/file, 3 MB/account, 5 files, 1 MB/save.
DEV_AUTH=1 PORT=$PORT DATA_DIR="$TMP/data" JWT_SECRET=test \
  MAX_FILE_BYTES=1048576 MAX_USER_BYTES=3145728 MAX_USER_FILES=5 MAX_SAVE_BYTES=1048576 \
  "$NODE" "$DIR/server.js" >"$TMP/log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -s -c "$J" -o /dev/null "$B/api/auth/dev/login?uid=attacker"
UID_A=$(curl -s -b "$J" "$B/api/me" | sed 's/.*"uid":"//;s/".*//')
[ -n "$UID_A" ] || { echo "could not sign in; log:"; cat "$TMP/log"; exit 1; }
echo "==> Cloud Locker abuse suite (uid=$UID_A, limits 1MB/file 3MB/acct 5 files)"

# --- unauthenticated access -------------------------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/saves")" = 401 ] && pass "anonymous read is 401" || fail "anon read" "not rejected"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data x "$B/api/blob/users/$UID_A/data/x.slf")" = 401 ] \
  && pass "anonymous write is 401" || fail "anon write" "not rejected"

# --- someone else's data ------------------------------------------------------------------------
[ "$(code -X PUT --data x "$B/api/blob/users/victim/data/x.slf")" = 403 ] && pass "write to another uid is 403" || fail "cross-user write" "allowed!"
[ "$(code "$B/api/blob/users/victim/data/x.slf")" = 403 ] && pass "read from another uid is 403" || fail "cross-user read" "allowed!"

# --- path traversal / weird paths ---------------------------------------------------------------
for p in "../../etc/passwd" "users/$UID_A/../../etc/passwd" "users/$UID_A/data/../../../x.slf"; do
  c=$(code -X PUT --data x "$B/api/blob/$p")
  [ "$c" = 403 ] || [ "$c" = 400 ] || [ "$c" = 404 ] || fail "traversal $p" "got $c"
done
pass "path traversal rejected"
c=$(jsonp /api/data/presign '{"path":"../../../etc/passwd","size":10}' | grep -c 'bad path'); [ "$c" = 1 ] \
  && pass "presign rejects traversal" || fail "presign traversal" "accepted"
c=$(jsonp /api/data/presign '{"path":"..\\..\\windows\\x.slf","size":10}' | grep -c 'bad path'); [ "$c" = 1 ] \
  && pass "presign rejects backslash paths" || fail "backslash path" "accepted"

# --- file-type gate: the locker is not a general file host --------------------------------------
c=$(jsonp /api/data/presign '{"path":"payload.exe","size":10}' | grep -c 'bad path'); [ "$c" = 1 ] \
  && pass "non-game extension rejected (.exe)" || fail "extension gate" ".exe accepted"

# --- per-file size cap --------------------------------------------------------------------------
c=$(jsonp /api/data/presign '{"path":"big.slf","size":99999999}' | grep -c 'too large'); [ "$c" = 1 ] \
  && pass "oversized presign rejected (per-file cap)" || fail "per-file cap" "not enforced"

# --- oversized BODY with honest and with LYING Content-Length -----------------------------------
head -c 2000000 /dev/zero > "$TMP/2mb.bin"
U=$(jsonp /api/data/presign '{"path":"ok.slf","size":1000}' | sed 's/.*"url":"//;s/".*//')
[ "$(code -X PUT --data-binary @"$TMP/2mb.bin" "$B$U")" = 413 ] && pass "2 MB body rejected (413)" || fail "oversized body" "accepted"
# Lying: declare 100 bytes, send 2 MB chunked. The stream guard must stop it regardless.
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" -X PUT -H 'Transfer-Encoding: chunked' \
      --data-binary @"$TMP/2mb.bin" "$B$U")
[ "$c" = 413 ] && pass "chunked oversized body rejected (no Content-Length to trust)" || fail "chunked upload" "got $c"
[ -f "$TMP/data/users/$UID_A/data/ok.slf" ] && fail "partial file" "oversized upload left a file behind" || pass "no partial file left on disk"

# --- account quota: 3 MB total, 1 MB per file ---------------------------------------------------
head -c 1000000 /dev/zero > "$TMP/1mb.bin"
okc=0; rej=0
for i in 1 2 3 4 5 6; do
  U=$(jsonp /api/data/presign "{\"path\":\"f$i.slf\",\"size\":1000000}" | sed 's/.*"url":"//;s/".*//')
  case "$U" in /api/blob/*) c=$(code -X PUT --data-binary @"$TMP/1mb.bin" "$B$U"); [ "$c" = 200 ] && okc=$((okc+1)) || rej=$((rej+1)) ;; *) rej=$((rej+1)) ;; esac
done
[ "$okc" -le 3 ] && pass "account quota enforced (stored $okc of 6 x 1 MB, rest refused)" \
  || fail "account quota" "stored $okc x 1 MB - over the 3 MB cap"

# --- file-count cap -----------------------------------------------------------------------------
cnt=$(find "$TMP/data/users/$UID_A" -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$cnt" -le 6 ] && pass "file count bounded ($cnt files on disk)" || fail "file count" "$cnt files"

# --- manifest cannot be used to fake unlimited storage ------------------------------------------
big='{"manifest":{"files":['; for i in $(seq 1 50); do big="$big{\"path\":\"m$i.slf\",\"size\":999999999},"; done
big="${big%,}]}}"
c=$(jsonp /api/data/presign "$big" | grep -cE 'over quota|bad manifest entry|too many files'); [ "$c" = 1 ] \
  && pass "hostile manifest rejected (count/size/quota validated)" || fail "manifest validation" "accepted"
# ...and one that is within the count/per-file caps but busts the account total.
c=$(jsonp /api/data/presign '{"manifest":{"files":[{"path":"a.slf","size":1000000},{"path":"b.slf","size":1000000},{"path":"c.slf","size":1000000},{"path":"d.slf","size":1000000}]}}' | grep -c 'over quota')
[ "$c" = 1 ] && pass "manifest totalling over the account quota rejected" || fail "manifest quota total" "accepted"
c=$(jsonp /api/data/presign '{"manifest":{"files":[{"path":"../../../evil.slf","size":1}]}}' | grep -c 'bad manifest entry')
[ "$c" = 1 ] && pass "manifest path traversal rejected" || fail "manifest traversal" "accepted"

# --- saves are capped too -----------------------------------------------------------------------
c=$(jsonp /api/saves/presign '{"name":"big.sav","op":"put","size":99999999}' | grep -c 'too large'); [ "$c" = 1 ] \
  && pass "oversized save rejected" || fail "save cap" "not enforced"
c=$(jsonp /api/saves/presign '{"name":"../../../evil","op":"put","size":10}' | grep -c 'bad name'); [ "$c" = 1 ] \
  && pass "save name traversal rejected" || fail "save name" "accepted"

echo
if [ "$FAILED" = 0 ]; then echo "==> all abuse checks passed"; else echo "==> $FAILED abuse check(s) FAILED"; fi
exit $FAILED
