# Self-hosting ja2-web

Grab `ja2-web-<tag>.zip` from
[Releases](https://github.com/Virtastic/ja2-web/releases) — it contains the
prebuilt engine and everything below. No compiler needed.

## Quick start (local)

```bash
unzip ja2-web-*.zip -d ja2-web && cd ja2-web
python3 server.py          # http://localhost:8795 (override with PORT=…)
```

Open the URL in **desktop Chrome/Chromium**. The launcher (`launcher.html`) lets
players read their own legally-owned JA2 Gold `Data` folder straight from disk —
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
— hosted here"** card (a `HEAD` probe of `ja2-gamedata.js`). When absent — the
default upload-only deploy — the card stays hidden and the launcher is
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

- **HTTPS** (or `http://localhost`) — isolation is only granted on secure origins.
- `application/wasm` MIME type for `.wasm`.
- Serve the precompressed `.gz` siblings with `Content-Encoding: gzip` when the
  client accepts it — this turns the ~10 MB wasm into ~3 MB over the wire (the
  `.js` loader and preloaded `.data` blob compress too). (`server.py` and the
  nginx config do this.)
- The engine files are content-versioned into `e/<hash>/`, so long cache
  lifetimes are always safe — a new build lands at a fresh URL; no purge needed.

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

Static hosts (Netlify, Cloudflare Pages, …) work too — set the same three
headers in the host's headers config.

## Browser support

Desktop Chrome/Chromium/Edge/Brave only (SharedArrayBuffer + WebAssembly threads
+ File System Access API). Firefox/Safari/mobile are not supported.

## Licensing notes for hosts

The bundle is GPLv3 (see `LICENSE`, `NOTICE`, `THIRD-PARTY-LICENSES.md`). If you
host it, link to the source (this repository or the matching
`ja2-web-src-<tag>.tar.gz`) somewhere reasonable — the included pages already do
this in their footers, so leaving them intact is enough. Jagged Alliance 2 game
data is **not** included and must never be bundled by hosts either.

---
WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-3.0-or-later
