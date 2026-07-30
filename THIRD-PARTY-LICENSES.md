# Third-party licenses

ja2-web is GPL-3.0-or-later (see [`LICENSE`](LICENSE)). It bundles and builds on
the components below, each under its own license. Full license texts live in the
respective source trees under `source-ja2/dependencies/` (and, for the
Emscripten-provided libraries, in the Emscripten SDK).

| Component | Role | License |
|-----------|------|---------|
| [JA2 Stracciatella](https://ja2-stracciatella.github.io/) | the game engine this is built on (`source-ja2/`) | GPL-3.0-or-later |
| [SDL2](https://www.libsdl.org/) | windowing / input / audio device (via the Emscripten SDL2 port) | Zlib |
| [miniaudio](https://miniaud.io/) | audio decoding & resampling (`MA_NO_DEVICE_IO`) | Public domain / MIT-0 |
| [stb_vorbis](https://github.com/nothings/stb) | Ogg Vorbis decoder | Public domain / MIT |
| [libsmacker](https://github.com/mvbxx/libsmacker) | Smacker (.smk) cutscene decoder | LGPL-2.1 |
| [string_theory](https://github.com/zrax/string_theory) | string handling | MIT |
| [magic_enum](https://github.com/Neargye/magic_enum) | enum reflection | MIT |
| [Lua](https://www.lua.org/) + [sol2](https://github.com/ThePhD/sol2) | scripting (build-time / optional) | MIT |
| [mimalloc](https://github.com/microsoft/mimalloc) | allocator (via Emscripten `-sMALLOC=mimalloc`) | MIT |
| [Emscripten](https://emscripten.org/) | C/C++ → WebAssembly toolchain | MIT / University of Illinois NCSA |

Build- and test-only tools (not shipped in the runtime): GoogleTest (BSD-3),
FLTK (LGPL-2.1 with static-linking exception).

No Jagged Alliance 2 game data (`Data/*.slf`) is included or distributed — that
content is commercial and must be supplied by the player from a copy they own.
