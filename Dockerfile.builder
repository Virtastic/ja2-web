# ja2-builder — one-time builder image baking the toolchain so the per-push deploy build (Dockerfile)
# is just the fast incremental JA2→WASM compile+link. Sibling of CS-Web's openmw-builder.
#
# Unlike OpenMW, JA2 (ja2-stracciatella) has a **Rust** backend that must be cross-compiled for
# wasm32-unknown-emscripten with -Zbuild-std (atomics/bulk-memory) to link into the -pthread build.
# Toolchain pin (wasm-build/env.sh): emscripten 6.0.1 + Rust nightly-2026-07-02 (other combos
# miscompile). All C/C++ deps build from source during the ninja run (no prebuilt .a to bake), and
# SDL2 comes from the emscripten port — so this image is purely the toolchain, no repo data.
#
# Build once on the VPS:  docker build -t ja2-builder:1 -f Dockerfile.builder .
# Rebuild only when the emscripten/Rust pins in wasm-build/env.sh change.
FROM emscripten/emsdk:6.0.1

# ninja (generator), brotli (make_br, unused on the nginx path but cheap), pkg-config, and
# build-essential — cargo needs a HOST cc/linker for proc-macros while -Zbuild-std compiles std.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ninja-build brotli git pkg-config python3 build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rust nightly, pinned to 2026-07-02. env.sh forces RUSTUP_TOOLCHAIN=nightly, so we install the
# DATED toolchain (reproducible) and then alias its dir to the bare `nightly` channel name — rustup
# resolves `nightly` to that directory OFFLINE (no per-build download, and the pin can never drift).
ENV RUSTUP_HOME=/root/.rustup CARGO_HOME=/root/.cargo PATH=/root/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- -y --default-toolchain nightly-2026-07-02 --profile minimal \
        --component rust-src --target wasm32-unknown-emscripten \
 && ln -s /root/.rustup/toolchains/nightly-2026-07-02-x86_64-unknown-linux-gnu \
          /root/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu \
 && RUSTUP_TOOLCHAIN=nightly rustc --version \
 && RUSTUP_TOOLCHAIN=nightly rustc --print target-list | grep -q wasm32-unknown-emscripten \
 && echo "rust nightly-2026-07-02 aliased to 'nightly', wasm target + rust-src staged OK"
