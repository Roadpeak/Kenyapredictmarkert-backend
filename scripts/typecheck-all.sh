#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
FAILED=0

# Build shared libs first
echo "Building shared libs..."
for lib in types decorators utils kafka-client exceptions; do
  if [ -f "libs/shared/$lib/tsconfig.lib.json" ]; then
    pnpm exec tsc --project "libs/shared/$lib/tsconfig.lib.json" 2>&1 || { echo "FAILED: lib/$lib"; FAILED=1; }
  fi
done

# Check all services
SERVICES=(auth-service user-service market-service trading-service wallet-service payment-service notification-service api-gateway analytics-service feed-service admin-service)

echo ""
echo "Checking services..."
for svc in "${SERVICES[@]}"; do
  result=$(pnpm exec tsc --project "apps/$svc/tsconfig.app.json" --noEmit 2>&1)
  if [ -z "$result" ]; then
    echo -e "${GREEN}✓${NC} $svc"
  else
    echo -e "${RED}✗${NC} $svc"
    echo "$result"
    FAILED=1
  fi
done

echo ""
[ $FAILED -eq 0 ] && echo -e "${GREEN}All checks passed${NC}" || { echo -e "${RED}Some checks failed${NC}"; exit 1; }
