variable "zone_name" {
  description = "Cloudflare zone (root domain)"
  type        = string
  default     = "virtastic.app"
}

variable "hostname" {
  description = "Public hostname for the deploy"
  type        = string
  default     = "ja2.virtastic.app"
}

variable "origin_ip" {
  description = "Origin server (OVH VPS) IPv4"
  type        = string
  default     = "135.148.33.60"
}
