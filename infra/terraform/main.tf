# Cloudflare config for ja2.virtastic.app (the JA2→WASM deploy on the shared OVH VPS).
# Manages DNS + edge caching declaratively. Same `virtastic.app` zone as morrowind - the SSL mode
# (Full strict) and Rocket Loader (off) are ZONE-WIDE and already set, so they're not managed here.
# The *.virtastic.app Origin Certificate already covers this hostname (no new cert).
#
# Auth: export CLOUDFLARE_API_TOKEN=... (a token scoped to the virtastic.app zone with
#   Zone:Read, DNS:Edit, Cache Rules:Edit). Then: terraform init && terraform apply

terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment (do NOT commit the token).
}

data "cloudflare_zone" "this" {
  name = var.zone_name
}

# DNS: ja2.virtastic.app -> the OVH VPS, proxied (orange cloud) so Cloudflare fronts it.
resource "cloudflare_record" "ja2" {
  zone_id = data.cloudflare_zone.this.id
  name    = "ja2"
  type    = "A"
  content = var.origin_ip
  proxied = true
  ttl     = 1 # 1 = automatic (required when proxied)
  comment = "JA2-WASM on the shared OVH VPS (managed by terraform)"
}

# NO cache ruleset here - deliberately. A Cloudflare zone has exactly ONE entrypoint ruleset per
# phase, and morrowind's terraform already owns the `http_request_cache_settings` ruleset for the
# shared `virtastic.app` zone; a second ruleset from this state would clobber it. Edge caching for
# ja2 therefore rides on the origin's Cache-Control: the container nginx sends
# `public, max-age=31536000, immutable` for *.{wasm,data,js}, which Cloudflare honors by default.
# If a cache-everything/override rule is ever wanted for ja2, ADD a rule to that shared ruleset in
# the morrowind (CS-Web) terraform state - do not create a competing ruleset here.
# (The deploy workflow still purges ja2.{js,wasm,data} on redeploy - stable names, changing bytes.)
