# ja2-cloud — OAuth login + S3 presign backend for the Cloud Locker (see cloud/server.js).
# Plain ESM JS (no build step). Same house rules as the openmw-mp server: tiny alpine runtime,
# non-root, no published host ports (only the shared edge Caddy reaches it on :8080).
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json server.js ./
# Local-storage mode writes to /data as the non-root user. Own it in the image so a fresh named
# volume mounted here inherits node ownership (Docker seeds an empty volume from the image path).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# busybox wget ships with alpine; /api/health is always up (reports s3/provider config).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.js"]
