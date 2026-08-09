#!/usr/bin/env bash
# Usage: bash scripts/prisma-all.sh [generate|migrate]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CMD="${1:-generate}"

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
    pnpm exec prisma migrate dev \
      --schema="apps/$svc/prisma/schema.prisma" \
      --name "init"
  elif [ "$CMD" = "studio" ]; then
    echo "Run manually: pnpm exec prisma studio --schema=apps/$svc/prisma/schema.prisma"
  fi
  echo ""
done

echo "Done: prisma $CMD for all services"
