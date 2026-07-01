#!/bin/sh
# Container entrypoint — one image, 11 possible services. SERVICE picks which
# app to run. On the container designated for bootstrap (APPLY_PRISMA_MIGRATIONS=1)
# we run prisma migrate deploy for EVERY service's schema before starting node.
set -e

: "${SERVICE:?SERVICE env var required (e.g. api-gateway, auth-service)}"

MAIN="/app/apps/${SERVICE}/dist/main.js"
if [ ! -f "$MAIN" ]; then
    echo "entrypoint: $MAIN not found — image build did not produce it" >&2
    exit 1
fi

# Direct path to the prisma CLI (installed via pnpm workspace at the standard
# node_modules location). pnpm is NOT in the runtime image; call node directly.
PRISMA_BIN="/app/node_modules/prisma/build/index.js"

if [ "${APPLY_PRISMA_MIGRATIONS:-0}" = "1" ] && [ -f "$PRISMA_BIN" ]; then
    for svc in auth-service user-service market-service trading-service \
               wallet-service payment-service notification-service analytics-service; do
        schema="/app/apps/${svc}/prisma/schema.prisma"
        if [ -f "$schema" ]; then
            echo "entrypoint: prisma migrate deploy → ${svc}"
            node "$PRISMA_BIN" migrate deploy --schema="$schema" || {
                echo "entrypoint: migrate failed for ${svc} — continuing anyway" >&2
            }
        fi
    done
fi

echo "entrypoint: starting ${SERVICE}"
exec node "$MAIN"
