# Changelog

All notable changes to ja2-web. Dates are ISO-8601. This project follows the
upstream JA2 Stracciatella engine version (currently **v0.22.1**) plus the WASM
port changes below.

## [Unreleased]

## [1.0.3] - 2026-09-27

### Fixed
- The map editor's file dialog is presented full-frame like the editor itself, instead of
  being zoomed as a 640x480 screen (same class of bug as #6).
- SELF_HOSTING.md: the nginx example's `types {}` block replaced nginx's whole MIME map,
  so `index.html` downloaded instead of rendering; removed. The nginx and Caddy examples
  now land on the launcher at `/`.

## [1.0.2] - 2026-09-27

### Added
- Docker image on GHCR: `docker run -p 8080:80 ghcr.io/virtastic/ja2-web:latest`.
- Every tagged release now ships the prebuilt self-host bundle (`ja2-web-<tag>.zip`).

### Fixed
- Self-hosted game data: the "Play now - hosted here" card no longer bounces back to the
  launcher (`server.py` rewrote `/index.html` to the launcher), and the hosted
  `ja2-gamedata.data` is fetched from the site root instead of the versioned engine dir
  (#8).
- The shop screen fits the window: it is drawn across the whole framebuffer like the
  battle screen, and is now presented the same way instead of zoomed as a 640x480
  screen (#6). The map editor gets the same treatment.
- Self-host bundles now include the engine fix for the false "running low on disk space
  - 0.00MB free" warning at the end of a turn (#5); 1.0.1 fixed it only on the site.
- Cloud Locker uploads of files over 100 MB no longer fail behind Cloudflare. Cloudflare
  caps proxied request bodies at ~100 MB, so same-origin uploads (local-storage mode) now
  slice large files into 64 MB chunks the server reassembles; the assembled file only
  becomes visible once every byte has landed, and all size/quota/verification limits are
  enforced against the whole file. Direct-to-S3 uploads are unaffected (not proxied).

## [1.0.1] - 2026-08-07

### Added
- **Cloud Locker** - sign in and keep your game data and savegames on your account, so
  any machine you sign in from has them. Single sign-on via Google, Discord or
  Microsoft; no password to create. Self-hosters can drop the feature entirely with
  `--build-arg CLOUD_LOCKER=0`.
- One-time upload wizard in the game: a checklist of the files your account needs,
  ownership confirmation, then one folder pick that finds and uploads everything.
- Two-tier upload verification - an exact checksum match against a known release, or a
  known filename whose size is within 5% (Jagged Alliance 2 shipped in many builds).
  Anything else is refused, so the locker only ever holds game data.
- Uploaded bytes are kept in the browser cache, addressed by content, so the first play
  after uploading reads locally instead of downloading the library back.
- Cloud saves sync automatically as you play.
- Storage works two ways: any S3-compatible object store, or plain local disk when no
  S3 is configured.
- Server-side abuse limits: per-file and per-save size caps, per-account byte and file
  quotas, a whole-install cap, and hard streaming byte ceilings.

### Changed
- Signing in goes straight into the game, and the tile always asks which provider to
  use rather than silently resuming the last account.
- Sessions last one browser session, renewing while you play, instead of a month.
- Uploads run four files at a time; downloads report true byte progress.

### Fixed
- HTML is served `no-store`. It previously carried no cache directives at all, so a
  browser could serve a stale `index.html` - which also pins the content-versioned
  engine path and could therefore point at a build that no longer exists.
- The player's `Data` folder is found when nested (for example GOG's Linux
  `game/Data`), not only one level down.
- The allowed file-extension list is derived from the known editions rather than
  hand-written, which had rejected the 109 `.jsd` files in a real install's TILECACHE.
- Stray markup copied from a sibling project produced a duplicate `<canvas>`, making
  the game render small and putting unrelated buttons on screen.

## [1.0.0] - 2026-07-30

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
- False "running low on disk space" warning at end of turn - the browser VFS
  reports 0 bytes free; `getFreeSpace` now reports plenty on wasm.
- Tactical sector-load crash (wasm stack overflow) - `-sSTACK_SIZE=8MB`.
- Garbled/loud audio (S16 samples fed to Web Audio as F32).
- Several screen-transition busy-wait loops that froze the browser tab.

[Unreleased]: https://github.com/Virtastic/ja2-web/compare/v1.0.1...ovhcloud
[1.0.1]: https://github.com/Virtastic/ja2-web/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Virtastic/ja2-web/releases/tag/v1.0.0
