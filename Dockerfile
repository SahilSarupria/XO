# syntax=docker/dockerfile:1
# UW-17 (ADR 0023) — the one production image of an XO instance: the API, the schedule triggers and Studio, on one port.
# Local and cloud differ only in configuration (docs/INSTANCE.md, docs/CONFIGURATION.md).
#
#   docker build -t xo-instance .
#   docker compose up            # one instance, with its data, anchors and keys on separate volumes (compose.yaml)
#
# State lives in /data (XO_DATA_DIR). The secrets key and the audit anchors are kept OUT of it on purpose: mount them separately.
# With NODE_ENV=production the instance refuses to start without durable audit (XO_AUDIT_RETENTION_DAYS, XO_AUDIT_MIN_RETENTION_DAYS)
# and without a package trust policy (XO_PACKAGE_TRUST_POLICY); compose.yaml sets local defaults instead.

FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# --ignore-scripts: nothing from the registry runs code at install time; native pieces (argon2, pdfium, tesseract) ship prebuilt.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && test -f apps/studio/dist/index.html \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    XO_ENV=production \
    XO_DATA_DIR=/data \
    XO_STUDIO_DIR=/app/apps/studio/dist \
    HOST=0.0.0.0 \
    PORT=4000
WORKDIR /app
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps ./apps
RUN useradd --system --uid 10001 --no-create-home xo \
 && mkdir -p /data /anchors /keys \
 && chown xo /data /anchors /keys \
 && chmod 700 /data /anchors /keys \
 && ln -s /app/apps/cli/bin/xo.js /usr/local/bin/xo
USER xo
VOLUME ["/data"]
EXPOSE 4000
# Readiness, not just liveness: storage writable, schema current, the instance lock held.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "apps/api/dist/index.js"]
