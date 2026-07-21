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

## Token

One Cloudflare API token, scoped to the **virtastic.app zone**, covers everything ja2 needs — and
it can be the **same shared token nostalgia/morrowind already use** (same zone). Required scopes:

| Used by | Scopes |
| --- | --- |
| Terraform (this dir — the DNS A record) | `Zone:Read` + `DNS:Edit` |
| CI cache purge (deploy-ovh.yml) | `Cache Purge` |

Note: ja2's terraform does NOT manage the cache ruleset (see below), so it does **not** need
`Cache Rules:Edit` — only `Zone:Read + DNS:Edit`. The CI purge needs `Cache Purge`.

**In CI this is the existing org secret** `CLOUDFLARE_API_TOKEN` (Virtastic org, shared with the
sibling openmw-web/freecad-wasm repos on the same zone). It must be **shared with `Virtastic/ja2-web`**
(the org secret has `SELECTED` visibility):

```sh
RID=$(gh api /repos/Virtastic/ja2-web --jq .id)
gh api --method PUT /orgs/Virtastic/actions/secrets/CLOUDFLARE_API_TOKEN/repositories/$RID
```

## Apply (manual — DNS is one-time; not run in CI)

The DNS record is applied by hand, not by the pipeline: terraform state here is **local**
(`terraform.tfstate`, gitignored), so the CI runner has no state and a per-push `apply` would try to
recreate the already-live record. The record effectively never changes, so manual is correct. (To
ever move this into CI, first move state to a remote backend, e.g. an HTTP/S3 backend or Terraform
Cloud, and `terraform import` the existing record.)

```sh
export CLOUDFLARE_API_TOKEN=...   # the shared virtastic.app token (Zone:Read + DNS:Edit)
terraform init
terraform apply
```

## What CI DOES automate (Cloudflare)

The deploy workflow (`.github/workflows/deploy-ovh.yml`) owns the **recurring** Cloudflare task: it
purges the edge cache for `ja2.{js,wasm,data}` after each deploy (those keep stable filenames but
change every build, so the immutable cache would otherwise serve a stale engine). It reads the org
secret **`CLOUDFLARE_API_TOKEN`** (needs `Cache Purge`); the virtastic.app zone id is hardcoded in the
step (not secret). If the secret isn't shared with this repo, the step logs a warning and skips
(deploy still succeeds).

## Cache staleness (important)
`ja2.{js,wasm,data}` keep stable filenames but change every engine build, so the 30-day edge cache
will serve a **stale engine after a redeploy** unless purged. The deploy workflow purges these paths
after each deploy; if the CF token lacks `Cache Purge`, purge them manually in the dashboard.
