# JA2 Stracciatella → WebAssembly: adaptations

Port of ja2-stracciatella v0.22.1 to run natively in Chrome, following the
patterns proven in CS-Web (OpenMW) and FreeCAD-Web.

## Toolchain (pinned in `wasm-build/env.sh`)

- **Emscripten 6.0.1** (homebrew `emcc`) — same major as CS-Web.
- **Rust nightly (1.98.0-nightly, 2026-07-02)** targeting `wasm32-unknown-emscripten`
  with `-Zbuild-std=std,panic_abort` and
  `RUSTFLAGS=-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals`.
  - Prebuilt rust std is built *without* atomics/bulk-memory and cannot join a
    `-pthread` (shared-memory) link — build-std on nightly is mandatory.
  - **Do not use nightly-2024-09-01** (first pin attempt): it miscompiles
    `std::path` on this target — `PathBuf::push(&Component)` writes NUL bytes
    (repro kept in `wasm-build/smoke2/`). Symptom in-game: every resolved path
    collapsed to `/`, VFS init failed. Latest nightlies are clean.
- **Exceptions:** `-fexceptions` (JS EH) on every C++ object and in
  `EMCC_CFLAGS` for rustc's emcc invocations. Do not mix with `-fwasm-exceptions`.
- **No `-flto`** (CS-Web gotcha: wasm-ld miscompiles/crashes).

## Source changes (all in `source-ja2/`, desktop behavior unchanged)

- `src/sgp/SGP.cc` — the blocking `MainLoop()` is split: the SDL-event switch
  moved to `HandleSDLEvent()`; under `__EMSCRIPTEN__` an exported
  `ja2_pump_frame()` drains events + runs one 144Hz-throttled game cycle, and
  `MainLoop()` signals `Module.onGameReady` then calls
  `emscripten_exit_with_live_runtime()`. The page pumps via MessageChannel+RAF
  (`play/index.html`) so hidden tabs keep running (RAF-only loops throttle).
- `rust/stracciatella/src/config/stracciatella_home.rs` — emscripten branch:
  home = `$HOME` (set to `/userdata` by the page) instead of `dirs::home_dir()`
  which is unsupported on emscripten.
- `rust/stracciatella/src/fs.rs` — `resolve_existing_components` uses
  `push(component.as_os_str())` (see miscompilation note above; kept as
  defense-in-depth, it is also simply more explicit).
- `CMakeLists.txt` — `EMSCRIPTEN` branch: SDL2 via the emscripten port
  (`-sUSE_SDL=2` interface target, no `find_package`); `JA2_WASM_LINK_FLAGS`
  cache var applied via `target_link_options` on the `ja2` target only (so
  cmake `try_compile` feature checks are not polluted by `--preload-file` etc).
- `dependencies/lib-stracciatella/CMakeLists.txt` — `EMSCRIPTEN` branch:
  `CARGO_BUILD_TARGET=wasm32-unknown-emscripten`, target-feature RUSTFLAGS,
  `CARGO_UNSTABLE_BUILD_STD=std,panic_abort`, `EMCC_CFLAGS`, `RUSTUP_TOOLCHAIN`
  passthrough.
- `rust/Cargo.lock` — `ahash 0.7.6 → 0.7.8` (removed-`stdsimd`-feature build
  failure on modern nightly).

## Filesystem layout (browser)

| Path        | Backing        | Contents |
|-------------|----------------|----------|
| `/game`     | preloaded .data (`--preload-file fsroot@/game`) | `externalized/`, `mods/`, `gamedata/` (JA2 `Data/*.slf`) |
| `/userdata` | IDBFS (IndexedDB, persists) | `.ja2/` home: `ja2.json`, `ja2.log` (TMPDIR points here), `SavedGames/` |

`FS.syncfs` runs every 15 s, on `visibilitychange`/`pagehide`. `EXTRA_DATA_DIR=/game`
is baked into the Rust build as the assets-dir fallback (no `/proc/self/exe` on wasm).

## Launcher / data chooser

`play/launcher.html` is a JA2-themed **data chooser** (modeled on OpenMW-web's):
two cards — **Play the demo** (→ `index.html?demo`, bundled sample) and **Bring
your own JA2** (a folder picker). The own-data flow uses the File System Access
API: `showDirectoryPicker()` → validate `Data/*.slf` + sniff Wildfire / 1.13 →
store the `FileSystemDirectoryHandle` in IndexedDB (db `ja2-launcher`, store
`handles`) → `index.html?src=local`. A "remembered install" fast-path re-uses the
saved handle. `play/index.html` reads that handle in `preRun`
(`mountOwnDataFolder`) and **copies** the picked `Data/` tree into MEMFS at
`/owndata/data` (no big download), then writes `game_dir=/owndata` +
`resversion` into `ja2.json`. The bundled/demo path instead dynamically loads the
`ja2-gamedata.js` data package (skipped entirely for `?src=local`). Loading UI is
a themed full-screen overlay matching the chooser (crosshair glyph, progress bar
driven by `Module.setStatus` download %, fades out on `onGameReady`).

Note on Wildfire: the engine's `VanillaVersion` enum has only the 9 *language*
editions (no `WILDFIRE`), so Wildfire is detected + surfaced but runs as plain
data (partial). The old faithful FLTK-style settings launcher is retained as
`play/settings.html` (unlinked from the chooser).

An earlier faithful FLTK-recreation launcher wrote the same `/userdata/.ja2/ja2.json`
via the IDBFS IndexedDB store directly (db `/userdata`, store `FILE_DATA`, v21), so
launcher and game share configuration with no wasm needed on the launcher page.
A literal FLTK-on-wasm build was spiked (`wasm-build/fltk-release-1.4.3`,
emcmake configure succeeds, widget sources compile): FLTK 1.4.3 has **no wasm
platform layer** — `FL/platform.H` falls through to X11 types, so shipping the
FLTK binary requires authoring a complete new driver backend
(Fl_Screen_Driver / Fl_Graphics_Driver / Fl_Window_Driver + event loop over
SDL2 or canvas, est. 3–5k LOC). Parked pending an explicit go decision; the
HTML launcher provides the same functionality against the same config file.

## Audio (SoundMan.cc)

miniaudio is compiled with `MA_NO_DEVICE_IO` — it's a codec/resampler only; the
device layer is one of two web backends:

- **AudioWorklet (default):** the mixer (`SoundCallback`) runs on the browser's
  real-time audio thread via emscripten's Wasm Audio Worklets API
  (`-sAUDIO_WORKLET=1 -sWASM_WORKERS=1`). This is the same threading model the
  desktop build has always used (SDL audio thread): all cross-thread audio data
  flows through miniaudio's lock-free SPSC ring buffers, and the callback never
  takes a blocking lock (try_lock/notify only — worklet threads forbid waits).
  The context runs at the device rate; the callback stages interleaved S16 and
  converts to the planar float32 the Web Audio API wants. Game frames can no
  longer starve the mixer, and the deprecated ScriptProcessorNode warning is gone.
- **`?audio=legacy`:** the previous SDL2/ScriptProcessorNode path (main-thread
  mixing), kept compiled-in as a one-parameter rollback.

Fixes that apply to both backends:
- **Sample rate:** the device/context rate (usually 48000) is learned at init and
  decoders/converters target it — feeding 44100-rate frames to a 48000 device
  made everything play ~8.8% pitch/speed shifted.
- **Buffer size:** `SOUND_SAMPLES` 1024 → 4096 on wasm (relevant to the legacy
  main-thread path; the worklet renders 128-frame quanta regardless).
- **No streaming:** `SOUND_FILE_STREAMING_THRESHOLD` is raised so large sounds
  (incl. music) load fully into memory rather than streaming — streamed decode
  would read the Rust VFS from the buffer-service worker thread.

## Rendering / window fit (per-screen presentation)

Internal resolution defaults to the **browser window size** (capped, even values).
This exploits JA2's own layout split: the tactical/battle screen's viewport fills
`m_screenWidth × (m_screenHeight-120)` and does NOT use the centering offset
(`game/UILayout.cc:119-126`), so at browser resolution the **battle screen renders
natively** — crisp, with more of the sector visible. Every other screen (menu,
laptop, A.I.M., strategic map, save/load, credits) draws fixed 640×480 art
*centered* via `STD_SCREEN_X/Y = (SCREEN_WIDTH-640)/2` (`UILayout.cc:68-69`).

`play/index.html`'s **`layoutCanvas()`** presents each screen by resizing only the
canvas *element's* CSS box (framebuffer untouched):
- **Battle (GAME_SCREEN):** present the whole framebuffer fit-to-window.
- **Fixed-UI screens:** zoom the centered 640×480 sub-region up to fill the window,
  so those screens look exactly as they did at native 640×480 — no black island.

The engine reports the active screen: `ja2_pump_frame()` (`sgp/SGP.cc`) watches
`guiCurrentScreen` and, on change, calls `window.__ja2SetScreen(id)` via `EM_ASM`
(MSG_BOX/FADE overlays keep the current mode, so a dialog over the battle screen
doesn't flip the view). Input stays exact because SDL2's emscripten mouse handler
maps `mx = targetX * window->w / cssW` — the CSS-zoom box makes a click land on the
precise framebuffer pixel the game's mouse region expects (no engine input change).

**Backing-store gotcha:** `layoutCanvas()` must NOT set a canvas CSS size before
the SDL window exists. `Emscripten_CreateWindow` probes the canvas CSS size and, if
present on a resizable window (`external_size`), sizes the backing store from CSS
instead of the requested resolution — a feedback loop that collapses the
framebuffer. It's gated on `window.__ja2Booted` (set in `Module.onGameReady`).

`?res=classic` restores the old 640×480-everywhere behavior; `?res=WxH` /
`?res=window` pin a specific / the window size. Scaling mode defaults to LINEAR on
web (JA2's pixel-perfect mode hard-errors when game res > desktop size).

## Stack size (the tactical sector-load crash)

Entering the **tactical sector** (`SetCurrentWorldSector` → `LoadWorld` →
`LoadWorldFromSGPFile`, e.g. when the first hired merc arrives after time
compression) **overflowed the wasm stack**. Emscripten's default stack is only
**64 KB**; the world-map loader uses far more. The overflow silently corrupted
adjacent linear memory, which surfaced downstream as misleading symptoms —
a mimalloc "operation does not support unaligned accesses" atomic trap, a
dlmalloc "memory access out of bounds", and random hard renderer crashes.
`-sSTACK_OVERFLOW_CHECK` pinpointed the true cause (`Aborted(stack overflow ...
LoadWorldFromSGPFile)`).

**Fix:** `-sSTACK_SIZE=8388608` (8 MB, desktop-sized) in the ja2 link flags
(`wasm-build/env.sh`). Keep `-sMALLOC=mimalloc` (the atomic/OOB symptoms were
stack corruption, not the allocator). After this the game loads into live
turn-based tactical combat. `-sSTACK_OVERFLOW_CHECK=1` served as the safety net
during stabilization and was removed once stable — it adds a check to every
function call.

## Performance flags (wasm SIMD)

`-msimd128` is enabled everywhere (C++ `JA2_COMMON_FLAGS`/`EMCC_CFLAGS`, Rust
`RUSTFLAGS` `+simd128`). JA2's hottest code is the per-frame software blitters
(8bpp→16bpp palette blits); auto-vectorization roughly **halved frame times**
(menu avg 0.85→0.38 ms; editor p95 8.0→2.6 ms; tactical at full browser
resolution runs ~1.3 ms avg / 2.7 ms p95). Measure with `?perf` in the page URL:
`window.__ja2FrameStats` = rolling `{n, avg, p95, max}` of `ja2_pump_frame` (ms).

**Debugging tooling** (`wasm-build/harness.mjs`, `repro.sh`): a dependency-free
headed-Chrome CDP driver (Node built-in WebSocket) that replaces the flaky
browser extension — launch / click / screenshot (CSS-sized) / eval / `logs`
(streams the browser console + exceptions to a file). Run Chrome **headed**, not
`--headless` (headless SharedArrayBuffer/pthreads hard-crashes). Lesson: for a
wasm crash, capture the assertion/console log first — don't guess.

## Blocking transition loops (freeze fix)

Several JA2 screen transitions animate a zoom effect with a `while` loop that
busy-waits on real time (`SDL_GetTicks`) while calling `RefreshScreen()` every
iteration, never returning to the per-frame game loop. On desktop that blocks
for 1–2s (fine); in the browser it hangs the tab — the main thread can't return
to the event loop, and the canvas can't even repaint mid-loop so the animation
is invisible anyway. The freeze reproduced when the first hired merc arrives at
Omerta and the game enters the tactical sector (`EnterSector` → `BeginLoadScreen`).
A full audit of the entire codebase (Tactical, TileEngine, Laptop, all UI,
Strategic, save/load, sgp, cutscenes) found **five** loops with this pattern —
all now guarded to skip on `__EMSCRIPTEN__` (the transition just cuts):
- `src/game/Strategic/StrategicMap.cc` `BeginLoadScreen()` (sector-load zoom) — the one that reproduced the reported freeze on merc arrival
- `src/game/Strategic/PreBattle_Interface.cc` `InitPreBattleInterface()` (pre-battle zoom)
- `src/game/Strategic/Auto_Resolve.cc` (auto-resolve zoom)
- `src/game/Laptop/Laptop.cc` laptop power-up (open) zoom — fires on every laptop open
- `src/game/Laptop/Laptop.cc` laptop power-down (close) zoom — fires on every laptop close

The audit confirmed the **tactical combat engine is already fully event-driven**
(movement, shooting, interrupts, animations advance one step per frame via
counters like `ubAttackBusyCount`, not blocking loops), so combat does not freeze.
The subsequent `LoadWorld()` is a normal synchronous load (a brief loading
pause), not a busy-wait. Debug-only loops (`FOV.cc`, `PathAI.cc`) are `#ifdef
_DEBUG`/`PATHAI_VISIBLE_DEBUG`, not in release builds.

## Serving

`play/server.py` (dev) and `infra/nginx.conf` (prod) set
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
(required for SharedArrayBuffer/pthreads) and support HTTP Range.
`wasm-build/make_br.sh` precompresses artifacts with brotli.

## Build

```
wasm-build/configure-ja2.sh     # emcmake configure into build-wasm/
ninja -C build-wasm ja2         # cargo (rust) + C++ + link → ja2.js/.wasm/.data
python3 play/server.py          # serve; open http://localhost:8796/launcher.html
node wasm-build/verify-browser.mjs   # headless boot smoke test
```

## Game data

The engine requires the original commercial `Data/*.slf` archives (never
open-sourced; only the code was released). Place them at
`fsroot/gamedata/data/` and rebuild (they get packed into `ja2.data`).
