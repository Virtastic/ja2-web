# syntax=docker/dockerfile:1
# =============================================================================================
# Per-push deploy image for ja2.virtastic.app.
#  - builder stage: incremental JA2→WASM build (FROM the prebaked ja2-builder image).
#  - runtime stage: nginx:alpine serving the web root with the app's serving contract
#    (infra/nginx.conf - COOP/COEP/CORP for SharedArrayBuffer, launcher gate, immutable caching).
# Built + tagged `ja2:ovh` by .github/workflows/deploy-ovh.yml on the Virtastic self-hosted runner.
# UPLOAD-ONLY: no game data is shipped - the launcher's bring-your-own path (index.html?src=local)
# is the only way in, so ja2-gamedata.*/ja2-lean.* are deliberately NOT copied.
# =============================================================================================

# ---- builder ---------------------------------------------------------------------------------
FROM ja2-builder:1 AS builder
WORKDIR /build

# Engine source + build recipe. env.sh derives JA2WEB_ROOT=/build; configure-ja2.sh runs emcmake
# cmake -S source-ja2 -B build-wasm; the link preloads fsroot@/game (the 42 MB tracked engine data).
COPY source-ja2 /build/source-ja2
COPY fsroot     /build/fsroot
COPY wasm-build /build/wasm-build
# NOTE: the static play/*.html are copied in the RUNTIME stage (from context), NOT here - editing
# them must not invalidate this compile layer and trigger a full recompile.

# configure → compile+link (emits ja2.{js,wasm,data}) → stage into play/. Cache mounts keep re-runs
# incremental: build-wasm (cmake+ninja objects), the cargo registry/git (crate downloads), and the
# Rust target dir (build-std artifacts - the slow part; target/ is gitignored so masking is safe).
# Distinct cache `id`s - BuildKit keys cache mounts by id (default = target path), and the sibling
# morrowind image mounts the SAME target=/build/build-wasm on this shared runner. Without unique ids
# the two projects' cmake caches collide ("source does not match ... used to generate cache").
RUN --mount=type=cache,id=ja2-build-wasm,target=/build/build-wasm \
    --mount=type=cache,id=ja2-cargo-registry,target=/root/.cargo/registry \
    --mount=type=cache,id=ja2-cargo-git,target=/root/.cargo/git \
    --mount=type=cache,id=ja2-rust-target,target=/build/source-ja2/rust/target \
# source-ja2/assets/mods is gitignored (40 MB of community mods), so it's absent in a clean checkout
# and cmake's desktop-only "copy assets next to the binary" post-build step errors on it. The WASM
# build doesn't use that copy - game data is preloaded from fsroot@/game (with its own fsroot/mods)
# - so an empty dir satisfies the copy without bloating the image.
    mkdir -p source-ja2/assets/mods \
 && bash wasm-build/configure-ja2.sh \
 && . wasm-build/env.sh && ninja -C build-wasm ja2 \
 && mkdir -p /build/play \
 && cp build-wasm/ja2.js build-wasm/ja2.wasm build-wasm/ja2.data /build/play/ \
# Precompress for nginx gzip_static (infra/nginx.conf): Cloudflare doesn't compress
# .data (octet-stream) at the edge, so without these the 42 MB preload ships raw.
 && gzip -9 -k -f /build/play/ja2.js /build/play/ja2.wasm /build/play/ja2.data

# ---- runtime ---------------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
# The purpose-built vhost: COOP/COEP/CORP on every response (SharedArrayBuffer/pthreads), launcher
# as the landing page, immutable caching for wasm/data/js. Replaces the stock default.conf.
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
# Static web files straight from the build context (editing them = a fast runtime-only rebuild).
COPY play/index.html play/launcher.html play/settings.html /usr/share/nginx/html/

# Cloud Locker on/off for this deployment. It is a deployment fact, not something the page should
# discover at runtime, so the tile is simply removed when the feature is off. Build with
# --build-arg CLOUD_LOCKER=0 for a static-only site (no /api backend, no sign-in tile).
ARG CLOUD_LOCKER=1
RUN if [ "$CLOUD_LOCKER" != "1" ]; then \
      sed -i 's|<div class="card actionable reveal d3" id="card-cloud" role="button" tabindex="0">|<div class="card actionable reveal d3" id="card-cloud" role="button" tabindex="0" hidden>|' \
        /usr/share/nginx/html/launcher.html; \
      echo "Cloud Locker tile disabled (CLOUD_LOCKER=$CLOUD_LOCKER)"; \
    fi
# Gameplay trailer (web-optimized 1080p H.264, faststart; converted from ja2-mov.mov).
COPY play/ja2-mov.mp4 /usr/share/nginx/html/
# Social/OG preview image referenced by the pages' og:image / twitter:image meta.
COPY play/og.png /usr/share/nginx/html/
# Data-verification manifests (per-edition file sizes) for the Cloud Locker upload check.
COPY play/data-manifests.json /usr/share/nginx/html/
# Built engine artifacts from the builder stage, with their .gz siblings for
# nginx gzip_static. (No ja2-gamedata.*/ja2-lean.* - upload-only.)
COPY --from=builder /build/play/ja2.js      /usr/share/nginx/html/
COPY --from=builder /build/play/ja2.js.gz   /usr/share/nginx/html/
COPY --from=builder /build/play/ja2.wasm    /usr/share/nginx/html/
COPY --from=builder /build/play/ja2.wasm.gz /usr/share/nginx/html/
COPY --from=builder /build/play/ja2.data    /usr/share/nginx/html/
COPY --from=builder /build/play/ja2.data.gz /usr/share/nginx/html/

# Content-version the engine: move ja2.{js,wasm,data}(+.gz) into /usr/share/nginx/html/e/<hash>/ and
# stamp that hash into index.html, so Cloudflare can never serve a mismatched mix of two builds (the
# "null function" crash). Alpine busybox has sh/sed/sha256sum. index.html stays no-cache, always current.
COPY wasm-build/version-engine.sh /tmp/version-engine.sh
RUN NAME=ja2 PLAY=/usr/share/nginx/html sh /tmp/version-engine.sh && rm /tmp/version-engine.sh

EXPOSE 80
