#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ─── 1. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example — review and fill in credentials"
else
  info ".env already exists — skipping copy"
fi

# ─── 2. JWT keypair ──────────────────────────────────────────────────────────
if ! grep -q "BEGIN RSA PRIVATE KEY" .env 2>/dev/null || grep -q "\.\.\.\\\\n\.\.\." .env; then
  info "Generating RS256 keypair..."
  openssl genrsa -out /tmp/pm_private.pem 2048 2>/dev/null
  openssl rsa -in /tmp/pm_private.pem -pubout -out /tmp/pm_public.pem 2>/dev/null

  PRIVATE_KEY=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' /tmp/pm_private.pem)
  PUBLIC_KEY=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' /tmp/pm_public.pem)

  # Replace placeholder values in .env
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|JWT_PRIVATE_KEY=.*|JWT_PRIVATE_KEY=\"${PRIVATE_KEY}\"|" .env
    sed -i '' "s|JWT_PUBLIC_KEY=.*|JWT_PUBLIC_KEY=\"${PUBLIC_KEY}\"|" .env
  else
    sed -i "s|JWT_PRIVATE_KEY=.*|JWT_PRIVATE_KEY=\"${PRIVATE_KEY}\"|" .env
    sed -i "s|JWT_PUBLIC_KEY=.*|JWT_PUBLIC_KEY=\"${PUBLIC_KEY}\"|" .env
  fi

  rm /tmp/pm_private.pem /tmp/pm_public.pem
  info "JWT keypair generated and written to .env"
else
  info "JWT keys already present in .env"
fi

# ─── 3. Docker infra ──────────────────────────────────────────────────────────
info "Starting Docker infrastructure..."
docker compose up -d postgres redis zookeeper kafka

# Wait for Postgres
info "Waiting for Postgres..."
for i in $(seq 1 30); do
  if docker exec predictmarket-postgres pg_isready -U postgres &>/dev/null; then
    info "Postgres ready"
    break
  fi
  [ $i -eq 30 ] && error "Postgres did not become ready in time"
  sleep 2
done

# Wait for Kafka
info "Waiting for Kafka..."
for i in $(seq 1 30); do
  if docker exec predictmarket-kafka kafka-topics --bootstrap-server localhost:9092 --list &>/dev/null; then
    info "Kafka ready"
    break
  fi
  [ $i -eq 30 ] && error "Kafka did not become ready in time"
  sleep 3
done

# ─── 4. Kafka topics ─────────────────────────────────────────────────────────
info "Creating Kafka topics..."
bash scripts/create-kafka-topics.sh

# ─── 5. Prisma generate + migrate ────────────────────────────────────────────
SERVICES=(auth-service user-service market-service trading-service wallet-service payment-service notification-service analytics-service)

for svc in "${SERVICES[@]}"; do
  info "Prisma generate: $svc"
  pnpm exec prisma generate \
    --schema="apps/$svc/prisma/schema.prisma" \
    --config="apps/$svc/prisma/prisma.config.ts" 2>&1 | tail -2

  info "Prisma migrate dev: $svc"
  pnpm exec prisma migrate dev \
    --schema="apps/$svc/prisma/schema.prisma" \
    --config="apps/$svc/prisma/prisma.config.ts" \
    --name "init" \
    --skip-seed 2>&1 | tail -3
done

# ─── 6. Build shared libs ────────────────────────────────────────────────────
info "Building shared libraries..."
for lib in types decorators utils kafka-client exceptions; do
  if [ -f "libs/shared/$lib/tsconfig.lib.json" ]; then
    pnpm exec tsc --project "libs/shared/$lib/tsconfig.lib.json" 2>&1 | tail -1
  fi
done

info "Setup complete! Start services with: pnpm run dev"
echo ""
echo "  Services: http://localhost:3000 (gateway)"
echo "  Swagger:  http://localhost:3000/docs"
echo "  Kafka UI: http://localhost:8080"
