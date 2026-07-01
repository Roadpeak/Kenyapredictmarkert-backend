#!/usr/bin/env bash
# Usage: bash scripts/prisma-all.sh [generate|migrate]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CMD="${1:-generate}"
SERVICES=(auth-service user-service market-service trading-service wallet-service payment-service notification-service analytics-service)

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
