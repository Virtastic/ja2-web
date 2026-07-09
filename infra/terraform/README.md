# Cloudflare (ja2.virtastic.app)

Declarative Cloudflare config for the JA2-WASM deploy: the DNS record + an edge cache rule for the
immutable engine assets. Same `virtastic.app` zone as morrowind.

## What it manages
- `cloudflare_record.ja2` — `ja2 A 135.148.33.60`, proxied (orange cloud). That's it.

## What it does NOT manage (and why)
- **Edge cache ruleset** — a zone has exactly ONE `http_request_cache_settings` entrypoint ruleset,
  and morrowind's terraform already owns it for the shared `virtastic.app` zone. A second ruleset
  here would clobber it. ja2's edge caching instead rides on the origin's `Cache-Control`
  (`immutable, max-age=1y` on `*.{wasm,data,js}` from the container nginx), which Cloudflare honors.
  Want a cache-everything/override rule for ja2? Add a rule to that shared ruleset in the CS-Web
  (morrowind) terraform — don't create a competing one here.
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
