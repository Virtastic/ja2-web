# ja2-web

Jagged Alliance 2 (Stracciatella v0.22.1) ported to run natively in Chrome via
WebAssembly — the full engine, backend, and UI, playing off the original game
data. Boots to the main menu, mouse/keyboard interactive, WebAudio sound, saves
persisted in the browser.

![status: boots to main menu and interactive](WASM_ADAPTATIONS.md)

## Layout

```
source-ja2/     vendored ja2-stracciatella-0.22.1, patched under #ifdef __EMSCRIPTEN__
wasm-build/     env.sh (toolchain pin) + configure/build/package/verify scripts, smoke tests
fsroot/         small preloaded tree baked into ja2.data: externalized/, mods/
gamedata-src/   the large *.slf game data (packaged separately at runtime)
play/           index.html, launcher.html, server.py + built ja2.{js,wasm,data} + ja2-gamedata.{js,data}
infra/          nginx.conf (COOP/COEP + brotli) for production
build-wasm/     cmake/ninja binary dir (generated)
```

## Build & run

```bash
# 1. one-time: game data from your own JA2 copy (see below), then:
wasm-build/bundle-data.sh ~/path/to/ja2install   # copies Data/ + repackages ja2-gamedata.*

# 2. build the engine
wasm-build/configure-ja2.sh          # emcmake configure
. wasm-build/env.sh && ninja -C build-wasm ja2
ln -sf ../build-wasm/ja2.{js,wasm,data} play/    # stage artifacts
wasm-build/package-data.sh           # (re)build play/ja2-gamedata.* if data changed

# 3. serve + play
python3 play/server.py               # http://localhost:8796/launcher.html
node wasm-build/verify-browser.mjs   # headless boot smoke test
```

`launcher.html` is the settings/mods launcher (writes `ja2.json`); `index.html`
runs the game. See [WASM_ADAPTATIONS.md](WASM_ADAPTATIONS.md) for the toolchain
pin, the source changes, and the filesystem/serving design.

## Game data

The engine requires the original commercial `Data/*.slf` archives — only the JA2
*source* was ever released, never the content. Supply them from a copy you own
(GOG/Steam install, or the retail CD images via `bchunk` + `unshield`) at
`gamedata-src/gamedata/data/` and run `wasm-build/package-data.sh`. Nothing
copyrighted is committed to this repo.
