#!/usr/bin/env bash
# One-time bucket setup for the Cloud Locker's S3 mode (OVH Object Storage, or any S3-compatible).
#
# The browser uploads game data and saves DIRECTLY to the bucket via presigned URLs, so the bucket
# needs CORS allowing the app origins. It must stay PRIVATE - presigned URLs are the only access
# path, and players' game data must never be world-readable.
#
# Reads credentials from the environment (never pass secrets as arguments - they land in shell
# history and the process list):
#   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY
#
# Usage:  set -a; . /path/to/cloud.env; set +a; cloud/s3-setup.sh
# Needs the aws CLI (brew install awscli / apt install awscli).
set -euo pipefail

: "${S3_ENDPOINT:?set S3_ENDPOINT}"; : "${S3_BUCKET:?set S3_BUCKET}"
: "${S3_ACCESS_KEY:?set S3_ACCESS_KEY}"; : "${S3_SECRET_KEY:?set S3_SECRET_KEY}"
REGION="${S3_REGION:?set S3_REGION}"
ORIGINS="${ORIGINS:?set ORIGINS to the app origin(s), space-separated}"

export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_DEFAULT_REGION="$REGION"
aws() { command aws --endpoint-url "$S3_ENDPOINT" --region "$REGION" "$@"; }

# Build the CORS rule. AllowedHeaders must include content-md5: S3 mode binds the expected MD5 into
# the presigned PUT, and the browser has to be allowed to send that header. ETag is exposed so the
# client can confirm what S3 stored.
rules=""
for o in $ORIGINS; do rules="$rules\"$o\","; done
cat > /tmp/ja2-cors.json <<JSON
{ "CORSRules": [ {
    "AllowedOrigins": [ ${rules%,} ],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["content-type", "content-md5", "content-length", "authorization", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
} ] }
JSON

echo "==> bucket:   $S3_BUCKET @ $S3_ENDPOINT ($REGION)"
echo "==> origins:  $ORIGINS"
aws s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration file:///tmp/ja2-cors.json
echo "==> CORS applied:"
aws s3api get-bucket-cors --bucket "$S3_BUCKET"
rm -f /tmp/ja2-cors.json

# The bucket must NOT be public. A public bucket would expose players' game data to the world.
echo "==> checking the bucket is private"
if curl -fsS -o /dev/null "${S3_ENDPOINT%/}/$S3_BUCKET/" 2>/dev/null; then
  echo "    WARNING: the bucket answered an unauthenticated request - make sure it is PRIVATE."
else
  echo "    ok: unauthenticated access refused"
fi

echo "==> write/read/delete round-trip"
echo ja2-cloud-setup-probe > /tmp/ja2-probe.txt
aws s3 cp /tmp/ja2-probe.txt "s3://$S3_BUCKET/_setup-probe.txt" >/dev/null
aws s3 cp "s3://$S3_BUCKET/_setup-probe.txt" /tmp/ja2-probe-back.txt >/dev/null
diff -q /tmp/ja2-probe.txt /tmp/ja2-probe-back.txt >/dev/null && echo "    ok: credentials can read and write"
aws s3 rm "s3://$S3_BUCKET/_setup-probe.txt" >/dev/null && echo "    ok: delete works (save sync needs it)"
rm -f /tmp/ja2-probe.txt /tmp/ja2-probe-back.txt
echo "==> bucket ready"
