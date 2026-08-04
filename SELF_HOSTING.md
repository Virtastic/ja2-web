# Self-hosting ja2-web

Grab `ja2-web-<tag>.zip` from
[Releases](https://github.com/Virtastic/ja2-web/releases) - it contains the
prebuilt engine and everything below. No compiler needed.

## Quick start (local)

Grab a [release](https://github.com/Virtastic/ja2-web/releases), unzip, and pick one:

```bash
unzip ja2-web-*.zip -d ja2-web && cd ja2-web

# A) no dependencies but Python:
python3 server.py           # http://localhost:8795 (override with PORT=…)

# B) Docker (bundled Dockerfile + compose):
docker compose up           # http://localhost:8080
```

Open the URL in **desktop Chrome/Chromium**. The launcher (`launcher.html`) lets
players read their own legally-owned JA2 Gold `Data` folder straight from disk -
no game data is shipped.

## Serving the game data yourself (optional)

If **you own the right to distribute JA2 data on your instance**, you can host it
so players click and play with no folder-picking or upload. Build the data package
from your own copy and drop it next to `index.html`:

```bash
wasm-build/bundle-data.sh ~/path/to/ja2install   # → play/ja2-gamedata.{js,data}
# deploy ja2-gamedata.js + ja2-gamedata.data alongside index.html / launcher.html
```

When those files are present, the launcher detects them and shows a **"Play now
- hosted here"** card (a `HEAD` probe of `ja2-gamedata.js`). When absent - the
default upload-only deploy - the card stays hidden and the launcher is
bring-your-own-only. Nothing else to configure.

> Jagged Alliance 2 data is commercial. Only host it where you have the right to
> (e.g. a private instance for your own use). Do not redistribute it publicly.

## The serving contract

The engine is multi-threaded WASM, which requires **cross-origin isolation**.
Your server must send these headers on **every** response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Plus:

- **HTTPS** (or `http://localhost`) - isolation is only granted on secure origins.
- `application/wasm` MIME type for `.wasm`.
- Serve the precompressed `.gz` siblings with `Content-Encoding: gzip` when the
  client accepts it - this turns the ~10 MB wasm into ~3 MB over the wire (the
  `.js` loader and preloaded `.data` blob compress too). (`server.py` and the
  nginx config do this.)
- The engine files are content-versioned into `e/<hash>/`, so long cache
  lifetimes are always safe - a new build lands at a fresh URL; no purge needed.

### nginx

```nginx
server {
    listen 443 ssl http2;
    root /srv/ja2-web;
    types { application/wasm wasm; }

    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy require-corp  always;
    add_header Cross-Origin-Resource-Policy cross-origin  always;

    gzip_static on;   # serve the .gz siblings
}
```

The reference vhost shipped with the repo is [`infra/nginx.conf`](infra/nginx.conf).

### Caddy

```caddy
example.com {
    root * /srv/ja2-web
    header {
        Cross-Origin-Opener-Policy   same-origin
        Cross-Origin-Embedder-Policy require-corp
        Cross-Origin-Resource-Policy cross-origin
    }
    file_server {
        precompressed gzip
    }
}
```

Static hosts (Netlify, Cloudflare Pages, …) work too - set the same three
headers in the host's headers config.

## Cloud Locker (optional): sign-in + cloud saves & data

The launcher's **Cloud Locker** tile lets players sign in (Discord / Google / Microsoft),
upload their own JA2 `Data` folder once, and have their game data **and** saves follow them to
any device. It's a small backend (`cloud/`) plus S3-compatible object storage - entirely
**optional and dormant** until you configure it. Without it, the tile shows the providers as
"Soon" and the game is bring-your-own-local exactly as before.

How it works: the backend only authenticates and mints **presigned URLs**; the browser transfers
game data and saves **directly to S3**, never through the backend. User records + manifests are
small JSON objects in the bucket (no database). It's served same-origin at `/api/*`.

**Storage - two modes:**
- **Local (default, simplest):** leave `S3_*` blank. Game data + saves persist to the `/data`
  volume and the backend serves them itself. No object store, no CORS to configure - just a disk.
- **S3:** fill in `S3_*`. The browser transfers **directly to S3** via presigned URLs (game data
  never proxies through the backend); the bucket needs **CORS** allowing your origin for
  `GET`/`PUT`/`DELETE`. Use this when you'd rather not host the bytes on the app server.

To enable it:

1. **OAuth apps** - register an app at whichever of Discord / Google / Microsoft you want, each
   with redirect URI `https://<your-host>/api/auth/<provider>/callback`. Only the providers you
   configure appear as live sign-in buttons.
2. **Config** - copy `cloud/.env.example` to `/opt/ja2/cloud.env` and fill in `JWT_SECRET`
   (`openssl rand -hex 32`), the `<provider>_CLIENT_*` pairs, and (only for S3 mode) the `S3_*`
   values. For local mode, `S3_*` stays blank.
3. The bundled `docker-compose.prod.yml` already defines the `ja2-cloud` service (with a
   `/data` volume) and routes `/api/*` to it - the edge `deploy/ja2.caddy` in front, or the
   image's own nginx if there's no edge. `docker compose up -d` brings it online.

**Abuse limits.** Anyone who can sign in can upload, so every limit is enforced **server-side**
(the launcher's edition check is a UX nicety - the API is what stops abuse). Out of the box:
512 MB per file, 64 MB per savegame, **4 GB and 4000 files per account**, and a 100 GB whole-install
cap in local mode. Uploads are streamed under a hard byte ceiling, so a lying or chunked
`Content-Length` can't overrun it; paths are validated (no traversal, bounded depth, game-data
extensions only) so the locker can't be used as a general file host. All are tunable - see
`cloud/.env.example`. `cloud/test-abuse.sh` runs the attack suite against a scratch instance.

Copyright note: hosting players' commercial `Data/*.slf` in their private per-user prefixes is
their upload; keep the bucket private (never public-read).

## Browser support

Desktop Chrome/Chromium/Edge/Brave only (SharedArrayBuffer + WebAssembly threads
+ File System Access API). Firefox/Safari/mobile are not supported.

## Licensing notes for hosts

The bundle is GPLv3 (see `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`). If you
host it, link to the source (this repository or the matching
`ja2-web-src-<tag>.tar.gz`) somewhere reasonable - the included pages already do
this in their footers, so leaving them intact is enough. Jagged Alliance 2 game
data is **not** included and must never be bundled by hosts either.

---
WASM port © 2025-2026 [Virtastic](https://virtastic.app) - GPL-3.0-or-later
