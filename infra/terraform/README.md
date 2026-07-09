# Cloudflare (ja2.virtastic.app)

Declarative Cloudflare config for the JA2-WASM deploy: the DNS record + an edge cache rule for the
immutable engine assets. Same `virtastic.app` zone as morrowind.

## What it manages
- `cloudflare_record.ja2` — `ja2 A 135.148.33.60`, proxied (orange cloud).
- `cloudflare_ruleset.cache` — cache-everything (30-day edge TTL) for `*.{wasm,data,js,css,png,jpg}`
  on `ja2.virtastic.app`; browser TTL respects the origin's `Cache-Control`.

## What it does NOT manage (already set zone-wide by the morrowind deploy)
- **SSL mode** (Full strict) and **Rocket Loader** (off) — zone-level, shared across all
  `virtastic.app` subdomains; set out-of-band via the Cloudflare API. Do not re-manage here.
- The **`*.virtastic.app` Origin Certificate** — already installed on the edge; covers this host.

## Apply
```sh
export CLOUDFLARE_API_TOKEN=...   # virtastic.app zone: Zone:Read + DNS:Edit + Cache Rules:Edit
terraform init
terraform apply
```

## Cache staleness (important)
`ja2.{js,wasm,data}` keep stable filenames but change every engine build, so the 30-day edge cache
will serve a **stale engine after a redeploy** unless purged. The deploy workflow purges these paths
after each deploy; if the CF token lacks `Cache Purge`, purge them manually in the dashboard.
