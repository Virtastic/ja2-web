# ja2-web

**Play Jagged Alliance 2 in your browser.** The JA2 Stracciatella engine, compiled to WebAssembly, by [Virtastic](https://virtastic.app).

<p>
  <a href="https://ja2.virtastic.app"><b>▶ Play now at ja2.virtastic.app</b></a> ·
  <a href="https://discord.gg/PzFfDkbSue">Discord</a> ·
  <a href="https://www.youtube.com/@Virtastic-Apps">YouTube</a> ·
  <a href="https://github.com/Virtastic/ja2-web/releases">Releases</a> ·
  <a href="https://github.com/Virtastic/ja2-web/issues">Issues</a> ·
  <a href="https://github.com/Virtastic/ja2-web/discussions">Discussions</a>
</p>

[![Discord](https://img.shields.io/badge/Discord-join%20the%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/PzFfDkbSue)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPLv3-blue)
![Platform: Chrome desktop](https://img.shields.io/badge/browser-Chrome%20%2F%20Chromium-brightgreen)
[![Latest release](https://img.shields.io/github/v/release/Virtastic/ja2-web)](https://github.com/Virtastic/ja2-web/releases)

ja2-web is a WebAssembly build of [JA2 Stracciatella](https://ja2-stracciatella.github.io/),
the open-source engine for *Jagged Alliance 2*. It is cross-compiled with Emscripten so
the whole engine — tactical combat, the strategic map, the laptop, sound — runs
client-side in a desktop browser. There is no plugin and no streaming service. The
engine runs locally and reads game data from your machine.

The `source-ja2/` tree tracks JA2 Stracciatella **v0.22.1**, plus local changes for the
WASM target: threading and main-loop changes, an AudioWorklet sound backend, wasm-SIMD
software blitters, browser-persistent saves, and a File System Access virtual
filesystem, among others. [`WASM_ADAPTATIONS.md`](WASM_ADAPTATIONS.md) is a writeup of
how the native desktop engine was made to run in a browser tab.

## Playing

Open [ja2.virtastic.app](https://ja2.virtastic.app) in desktop Chrome (or Chromium /
Edge / Brave), then:

- **Bring your own JA2.** Point the browser at the `Data` folder of a legally-obtained
  *Jagged Alliance 2 Gold* install. Files are read straight from disk via the File
  System Access API and copied into the engine, so there is no upload to a server. The
  folder you pick is remembered for next time.
  - On Windows, first copy that `Data` folder somewhere outside a protected system
    location, such as your Documents or Desktop folder: browsers refuse to open folders
    inside `Program Files`, and Steam's default library lives there.

Saves persist to disk in a `ja2-web-saves` folder inside the folder you picked (real
files, via the File System Access API), so they survive clearing browser data and can
be backed up like any other file. Config and the game log persist in the browser
(IndexedDB) and survive reloads. A themed loading screen shows real mount progress on
the way in.

The tactical (battle) screen renders at your full browser resolution — more of the
sector is visible than the classic 640×480 — while the fixed-art screens (menu, laptop,
A.I.M., strategic map) keep their original look. Add `?res=classic` to force
640×480-everywhere.

**Jagged Alliance 2 game data is not included or distributed here.** You need your own
legally-obtained copy to play. Vanilla JA2 (Gold) is what runs; expansions such as
Wildfire are detected but load as vanilla and are not supported.

## What's in this repo

This is a code-only repo. Large binaries (game data, dependency caches, build
artifacts) are excluded via [`.gitignore`](.gitignore) and must be provided or rebuilt
locally.

| Path | Purpose |
|------|---------|
| `source-ja2/` | JA2 Stracciatella engine source (upstream v0.22.1 plus local WASM changes under `#ifdef __EMSCRIPTEN__`) |
| `wasm-build/` | Toolchain pin (`env.sh`) + configure/build/package scripts, the CDP test harness, smoke tests |
| `fsroot/` | Small preloaded tree baked into `ja2.data`: `externalized/`, `mods/` |
| `play/` | Browser front-end: `launcher.html`, `index.html`, `server.py` dev server, built `ja2.{js,wasm,data}` |
| `infra/` | `nginx.conf` (COOP/COEP + gzip_static) and Terraform (DNS) for production |

### Not included (kept local)

- `gamedata-src/`, `gamedata-lean/`, `fsroot/gamedata/`, `play/ja2*.data`: commercial
  JA2 game data (`Data/*.slf`). Never committed — copyright.
- `build-wasm/` and all `*.wasm` / `*.data` build outputs.
- Prebuilt desktop SDL2 binaries and bulky community mods (get them from upstream
  Stracciatella if you need them).

## Running (dev)

You need your own JA2 game data to build the bundled dev package. Then:

```bash
# 1. one-time: stage your JA2 Data/ and repackage the data blob
wasm-build/bundle-data.sh ~/path/to/ja2install

# 2. build the engine
wasm-build/configure-ja2.sh                  # emcmake configure
. wasm-build/env.sh && ninja -C build-wasm ja2

# 3. serve play/ over a cross-origin-isolated origin
python3 play/server.py                       # http://localhost:8795 (set PORT= to change)
```

The dev server sets the cross-origin-isolation headers SharedArrayBuffer needs. Open the
URL in desktop Chrome. Set `OPENMW_LAUNCHER=0` to boot straight into the game instead of
the data chooser.

## Building

You need **Emscripten 6.0.1**, a **Rust nightly** toolchain, CMake, and Ninja. The exact
pins live in [`wasm-build/env.sh`](wasm-build/env.sh) (a mismatched Rust nightly
miscompiles `std::path` on `wasm32-unknown-emscripten` — do not drift off the pin).

```bash
wasm-build/configure-ja2.sh                  # emcmake cmake -S source-ja2 -B build-wasm
. wasm-build/env.sh && ninja -C build-wasm ja2
cp build-wasm/ja2.{js,wasm,data} play/
```

Things to watch, which is why the flags are scripted in `env.sh`:

- The whole build uses `-fexceptions` (JS exceptions, the rustc emscripten ABI) and
  `-pthread`. Do **not** add `-flto`.
- `-sSTACK_SIZE=8388608` (8 MB) — the world-map loader overflows the default 64 KB wasm
  stack.
- `-msimd128` (C++ and Rust `+simd128`) vectorizes the software blitters.
- Audio defaults to a Wasm AudioWorklet backend; `?audio=legacy` selects the old
  SDL/ScriptProcessor path.

## Hosting on a real server

Serve `play/` over HTTPS (`http://localhost` also counts) with these headers on every
response, so the page is cross-origin isolated (required for SharedArrayBuffer /
pthreads):

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Serve the precompressed `.gz` siblings with `Content-Encoding: gzip` (nginx
`gzip_static on;`). That takes the ~43 MB data blob down to ~11 MB and the ~10 MB wasm to
~3 MB over the wire. The reference vhost is [`infra/nginx.conf`](infra/nginx.conf). The
engine files are content-versioned into `e/<hash>/`, so a new build is served at a fresh
URL and the CDN can never serve a mismatched build.

## Browser support

Requires SharedArrayBuffer + WebAssembly threads (pthreads) and the File System Access
API — desktop **Chrome / Chromium / Edge / Brave**. Firefox and Safari are not
supported. Mobile and touch are out of scope (no on-screen controls).

## License

ja2-web is licensed under the **GNU General Public License, version 3 or later**. It is a
derivative work of JA2 Stracciatella, which is GPLv3, so the combined work is GPLv3. The
full text is in [`LICENSE`](LICENSE).

- Engine code (the `source-ja2/` tree and the WASM build changes) is GPLv3, following
  upstream Stracciatella.
- The front-end and tooling (`play/`, `wasm-build/`, `fsroot/` config, scripts) is
  released under the same GPLv3.
- Bundled dependencies keep their own licenses (SDL2, miniaudio, string_theory, and the
  rest) — see their source trees under `source-ja2/`.

### Game data and trademarks

*Jagged Alliance* is a trademark of its respective owners. This project is not
affiliated with, endorsed by, or associated with them. No Jagged Alliance 2 game data is
included or distributed here; you must own and supply your own legally-obtained copy. The
engine is an independent, open-source reimplementation (JA2 Stracciatella) and ships no
copyrighted assets.

## Community

- **[Discord](https://discord.gg/PzFfDkbSue)** — the fastest place for help, screenshots,
  and news.
- **[YouTube (@Virtastic-Apps)](https://www.youtube.com/@Virtastic-Apps)** — demos, build
  logs, and other native-to-browser ports we're working on.
- **[GitHub Discussions](https://github.com/Virtastic/ja2-web/discussions)** — longer-form
  questions and showcase threads.

Found a bug or want a feature? Open an [Issue](https://github.com/Virtastic/ja2-web/issues).
Pull requests are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Deployment and CI are
maintainer-only.

## Support the project

ja2-web is built and hosted by [Virtastic](https://virtastic.app). If you enjoy it, you
can support us on [Ko-fi](https://ko-fi.com/virtastic) or
[Patreon](https://patreon.com/virtastic). It pays for the servers that keep
ja2.virtastic.app free to play.

## Credits

- WASM port, tooling, and hosting: © 2025-2026 [Virtastic](https://virtastic.app). See
  [`NOTICE`](NOTICE).
- [JA2 Stracciatella](https://ja2-stracciatella.github.io/): the engine this is built on,
  by the ja2-stracciatella team.
