# Changelog

All notable changes to ja2-web. Dates are ISO-8601. This project follows the
upstream JA2 Stracciatella engine version (currently **v0.22.1**) plus the WASM
port changes below.

## [Unreleased]

### Added
- Full-resolution tactical (battle) screen - renders at the browser window size;
  fixed-art screens (menu, laptop, A.I.M., strategic map) keep 640×480. `?res=classic`
  restores classic everywhere.
- Wasm SIMD (`-msimd128`) software blitters - roughly halves per-frame time.
- Wasm AudioWorklet audio backend (real-time audio thread); `?audio=legacy` keeps
  the old SDL/ScriptProcessor path.
- Bring-your-own-JA2 data chooser: pick your `Data` folder via the File System
  Access API; the handle is remembered for next time.
- Folder-backed saves: saves mirror to a `ja2-web-saves` folder on disk inside the
  picked folder, surviving browser-data clears.
- `gzip_static` delivery + content-versioned engine paths (`e/<hash>/`).

### Fixed
- Tactical sector-load crash (wasm stack overflow) - `-sSTACK_SIZE=8MB`.
- Garbled/loud audio (S16 samples fed to Web Audio as F32).
- Several screen-transition busy-wait loops that froze the browser tab.

[Unreleased]: https://github.com/Virtastic/ja2-web/commits/ovhcloud
