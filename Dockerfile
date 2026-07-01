# syntax=docker/dockerfile:1.7

# ─── 1. Base with pnpm ────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN apk add --no-cache libc6-compat openssl bash
WORKDIR /work

# ─── 2. Install deps (cacheable layer) ────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY nx.json tsconfig.base.json tsconfig.json ./
# Workspace package.json files must be present for pnpm to link them.
COPY apps ./apps
COPY libs ./libs
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── 3. Build all 11 services + generate Prisma clients ───────────────────────
FROM deps AS build
# Prisma generate for every service that has a schema.
RUN pnpm run prisma:generate
# Build all 11 microservices in one nx run.
RUN pnpm exec nx run-many --target=build \
    --projects=api-gateway,auth-service,user-service,market-service,trading-service,wallet-service,payment-service,notification-service,feed-service,admin-service,analytics-service \
    --parallel=4 \
    --skip-nx-cache

# ─── 4. Runtime image (single image; SERVICE env var chooses which main.js runs)
FROM node:20-alpine AS runtime
RUN apk add --no-cache libc6-compat openssl tini
WORKDIR /app
ENV NODE_ENV=production

# Copy the whole workspace so pnpm workspace symlinks resolve at runtime.
# Prisma clients live under node_modules/.prisma (generated per schema) — those
# must survive as-is; pnpm prune sometimes removes generated dirs, so we keep
# the full node_modules from the build stage. Extra ~200MB is fine at this scale.
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/apps ./apps
COPY --from=build /work/libs ./libs
COPY --from=build /work/packages ./packages
COPY --from=build /work/package.json /work/pnpm-workspace.yaml /work/nx.json ./
COPY --from=build /work/scripts ./scripts

# Entrypoint dispatches to apps/${SERVICE}/dist/main.js.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run migrations lazily (only auth-service does it — see entrypoint) then start.
USER node
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
