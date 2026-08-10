#!/usr/bin/env bash
# Usage:
#   bash scripts/prisma-all.sh generate            # regenerate all clients (postinstall)
#   bash scripts/prisma-all.sh migrate             # deploy all pending migrations (prod / CI)
#   bash scripts/prisma-all.sh migrate:dev <name>  # author a new migration on the schema you changed
#   bash scripts/prisma-all.sh studio              # prints per-service studio commands
#
# Do NOT `prisma db push` any more — it skips the migration files
# that the prod workflow (`migrate deploy`) needs to see. Use
# `migrate:dev` instead so your schema change lands as a committed
# migration file that reviews cleanly and applies in prod.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CMD="${1:-generate}"
NAME="${2:-}"

# Discover services dynamically — every app with prisma/schema.prisma qualifies.
# Rationale: hardcoded lists get out of sync each time a new service lands
# (missed feed-service in the first pass, comments-service in the second). This
# glob is the ground truth used by the Dockerfile stage below too.
SERVICES=()
for schema in apps/*/prisma/schema.prisma; do
  SERVICES+=("$(basename "$(dirname "$(dirname "$schema")")")")
done

if [ "${#SERVICES[@]}" -eq 0 ]; then
  echo "no services found with apps/*/prisma/schema.prisma — bailing"
  exit 1
fi

echo "→ services discovered: ${SERVICES[*]}"

for svc in "${SERVICES[@]}"; do
  echo "→ prisma $CMD: $svc"
  if [ "$CMD" = "generate" ]; then
    pnpm exec prisma generate \
      --schema="apps/$svc/prisma/schema.prisma"
  elif [ "$CMD" = "migrate" ]; then
    pnpm exec prisma migrate deploy \
      --schema="apps/$svc/prisma/schema.prisma"
  elif [ "$CMD" = "migrate:dev" ]; then
    # migrate:dev generates a migration for the one service whose schema
    # changed. Running it across ALL services would try to author
    # duplicate migrations for schemas that haven't drifted. Skip services
    # whose DB already matches the schema.
    if [ -z "$NAME" ]; then
      echo "usage: bash scripts/prisma-all.sh migrate:dev <migration-name>" >&2
      exit 1
    fi
    if pnpm exec prisma migrate diff \
        --from-schema-datamodel "apps/$svc/prisma/schema.prisma" \
        --to-schema-datasource "apps/$svc/prisma/schema.prisma" \
        --exit-code >/dev/null 2>&1; then
      echo "  (no schema drift, skipping)"
      continue
    fi
    pnpm exec prisma migrate dev \
      --schema="apps/$svc/prisma/schema.prisma" \
      --name "$NAME"
  elif [ "$CMD" = "studio" ]; then
    echo "Run manually: pnpm exec prisma studio --schema=apps/$svc/prisma/schema.prisma"
  fi
  echo ""
done

echo "Done: prisma $CMD for all services"
