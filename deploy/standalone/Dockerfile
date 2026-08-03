# Dead-simple standalone image: serve a PREBUILT ja2-web bundle (no compiler needed).
# Used by the release bundle's `docker compose up`. For building the engine from source,
# see the repo-root Dockerfile instead.
FROM nginx:1.27-alpine
# COOP/COEP/CORP (SharedArrayBuffer), gzip_static, wasm mime, launcher at /.
COPY nginx.conf /etc/nginx/conf.d/default.conf
# The prebuilt front-end + engine (index.html, launcher.html, ja2.{js,wasm,data}(+.gz), …).
COPY . /usr/share/nginx/html/
EXPOSE 80
