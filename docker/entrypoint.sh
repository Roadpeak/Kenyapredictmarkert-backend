#!/bin/sh
# Container entrypoint — one image, 11 possible services. SERVICE env var picks
# which app to run. If APPLY_PRISMA_MIGRATIONS=1, run migrate deploy for that
# service's schema first (only sensible on the service that owns each DB — set
# via docker-compose env, not defaulted here).
set -e

: "${SERVICE:?SERVICE env var required (e.g. api-gateway, auth-service)}"

MAIN="/app/apps/${SERVICE}/dist/main.js"
SCHEMA="/app/apps/${SERVICE}/prisma/schema.prisma"

if [ ! -f "$MAIN" ]; then
    echo "entrypoint: /app/apps/${SERVICE}/dist/main.js not found — image build did not produce it" >&2
    exit 1
fi

if [ "${APPLY_PRISMA_MIGRATIONS:-0}" = "1" ] && [ -f "$SCHEMA" ]; then
    echo "entrypoint: applying prisma migrations for ${SERVICE} (${SCHEMA})"
    cd /app
    # Note: prisma config file is optional; fall back to schema-only if absent.
    CONFIG="/app/apps/${SERVICE}/prisma/prisma.config.ts"
    if [ -f "$CONFIG" ]; then
        node ./node_modules/.pnpm/node_modules/prisma/build/index.js migrate deploy \
            --schema="$SCHEMA" --config="$CONFIG" 2>&1 \
        || pnpm exec prisma migrate deploy --schema="$SCHEMA" --config="$CONFIG"
    else
        pnpm exec prisma migrate deploy --schema="$SCHEMA"
    fi
fi

echo "entrypoint: starting ${SERVICE}"
exec node "$MAIN"
