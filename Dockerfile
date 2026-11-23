# Keep build and runtime on the same Debian/glibc image family because
# better-sqlite3 is a native Node addon.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS build
# better-sqlite3 normally downloads a matching prebuild. These tools make a
# fallback native build possible for a platform without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . ./
RUN npm run check \
  && npm run build:mcp \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    TASKBOARD_DB_PATH=/var/lib/taskboard/taskboard.sqlite

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/dist-mcp ./dist-mcp
RUN mkdir -p /var/lib/taskboard \
  && chown node:node /var/lib/taskboard

USER node
VOLUME ["/var/lib/taskboard"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
