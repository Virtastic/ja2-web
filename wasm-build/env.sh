# Single-source toolchain env for ja2-web (source this from all build scripts)
#
# Pin history:
#  - emsdk 3.1.70 + rust nightly-2024-09-01: ABI-compatible, but that nightly
#    MISCOMPILES std path handling on wasm32-unknown-emscripten (Component
#    pushes produce NUL bytes; see wasm-build/smoke2). Do not use.
#  - emscripten 6.0.1 (homebrew, same as CS-Web) + rust nightly-2026-07-02
#    (1.98.0-nightly): verified clean by wasm-build/smoke2.
export JA2WEB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
# Homebrew emscripten 6.0.1 (emcc/em++/emcmake on default PATH)
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
# Prebuilt emscripten std lacks atomics/bulk-memory (can't join a -pthread link);
# nightly + build-std is required. Verified by wasm-build/smoke + smoke2.
export RUSTUP_TOOLCHAIN=nightly
export RUSTFLAGS="-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals,+simd128"
export EMCC_CFLAGS="-pthread -fexceptions -msimd128"
export JA2_CARGO_ARGS="-Zbuild-std=std,panic_abort"
# Common flags: JS exceptions (rustc emscripten ABI), pthreads.
# ST_DEFAULT_VALIDATION=substitute_invalid: string_theory's default is
# check_validity, which THROWS ST::unicode_error (→ hard abort) on any string with
# an invalid UTF sequence. Odd/older data (e.g. the JA2 demo's mis-encoded strings)
# then crashes the engine at content load. substitute_invalid replaces the bad
# code unit instead of throwing — strictly more permissive, never worse for valid
# data — which is the right default for a browser port fed arbitrary game folders.
# -msimd128: wasm SIMD for the software blitters (8bpp→16bpp palette blits are the
# hottest per-frame code); pure compiler auto-vectorization, Chrome-supported for years.
export JA2_COMMON_FLAGS="-pthread -fexceptions -O2 -msimd128 -DST_DEFAULT_VALIDATION=ST::substitute_invalid"
# Canonical link flags (CS-Web-derived). NO -flto. Game data preloaded from fsroot/.
# Game data (fsroot/gamedata, ~900MB of *.slf) is packaged SEPARATELY at runtime
# (wasm-build/package-data.sh) so relinks stay fast and the link only bakes the
# small externalized/mods tree. MAXIMUM_MEMORY=4GB: the SLFs live in MEMFS (RAM).
export JA2_LINK_FLAGS="-pthread -fexceptions -sPTHREAD_POOL_SIZE=8 \
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=4294967296 \
-sMALLOC=mimalloc -sEXIT_RUNTIME=0 -sSTACK_SIZE=8388608 -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 \
-sAUDIO_WORKLET=1 -sWASM_WORKERS=1 \
-lidbfs.js -sEXPORTED_FUNCTIONS=_main,_ja2_pump_frame \
-sEXPORTED_RUNTIME_METHODS=ccall,FS,ENV,callMain,addRunDependency,removeRunDependency \
--preload-file $JA2WEB_ROOT/fsroot@/game"
