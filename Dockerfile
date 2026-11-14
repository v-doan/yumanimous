# syntax=docker/dockerfile:1
# Production image: the API, which also serves the built web app (one origin).
#
# - Base image pinned by digest, so a re-tagged image can't change what ships.
# - Dependencies installed exactly from the lockfile, with install scripts off
#   (no third-party code runs at build time; native binaries come as packages).
# - The app runs as the unprivileged `node` user and can't modify its own code:
#   files are owned by root, and only /tmp is writable.

ARG NODE_IMAGE=node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

# ---- build: install everything, build the web app, then drop dev dependencies ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Manifests first, so the dependency layer is cached until they change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/mcp-recipes/package.json packages/mcp-recipes/
COPY packages/mcp-session/package.json packages/mcp-session/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build -w @yumanimous/web \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_STATIC_DIR=/app/apps/web/dist \
    # The Agent SDK's CLI needs a writable home for its config; keep it in /tmp.
    HOME=/tmp \
    CLAUDE_CONFIG_DIR=/tmp/claude \
    # No telemetry, error reporting or update checks from the agent runtime.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist

USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
