# Cloudflare config for ja2.virtastic.app (the JA2→WASM deploy on the shared OVH VPS).
# Manages DNS + edge caching declaratively. Same `virtastic.app` zone as morrowind — the SSL mode
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

# Edge caching: cache the immutable engine assets aggressively; let HTML respect origin no-cache.
# The origin (container nginx) already sends correct Cache-Control; this is the edge optimization.
# NOTE: ja2.{js,wasm,data} have stable names but change per build — purge the edge cache on redeploy
# (the deploy workflow does this) or a stale engine is served.
resource "cloudflare_ruleset" "cache" {
  zone_id = data.cloudflare_zone.this.id
  name    = "ja2-cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules {
    ref         = "ja2_assets"
    description = "Cache-everything for ja2.virtastic.app immutable assets"
    expression  = "(http.host eq \"${var.hostname}\" and http.request.uri.path.extension in {\"wasm\" \"data\" \"js\" \"css\" \"png\" \"jpg\"})"
    action      = "set_cache_settings"
    enabled     = true
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 2592000 # 30 days at the edge for the big immutable blobs
      }
      browser_ttl {
        mode = "respect_origin" # honor the origin's Cache-Control (immutable / no-cache)
      }
    }
  }
}
