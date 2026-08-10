-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "trade_events" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "pricePerShare" DECIMAL(6,4) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "won" BOOLEAN NOT NULL,
    "payoutKes" DECIMAL(15,2) NOT NULL,
    "costKes" DECIMAL(15,2) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_earnings" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "marketTitle" TEXT NOT NULL,
    "totalPoolKes" DECIMAL(15,2) NOT NULL,
    "rake" DECIMAL(4,3) NOT NULL,
    "earningsKes" DECIMAL(15,2) NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OVERALL',
    "pnlKes" DECIMAL(15,2) NOT NULL,
    "volumeKes" DECIMAL(15,2) NOT NULL,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "winRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_volumes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "volumeKes" DECIMAL(15,2) NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_volumes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_events_tradeId_key" ON "trade_events"("tradeId");

-- CreateIndex
CREATE INDEX "trade_events_marketId_occurredAt_idx" ON "trade_events"("marketId", "occurredAt");

-- CreateIndex
CREATE INDEX "trade_events_userId_occurredAt_idx" ON "trade_events"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "settlement_events_userId_settledAt_idx" ON "settlement_events"("userId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_events_userId_marketId_key" ON "settlement_events"("userId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "market_earnings_marketId_key" ON "market_earnings"("marketId");

-- CreateIndex
CREATE INDEX "market_earnings_resolvedAt_idx" ON "market_earnings"("resolvedAt");

-- CreateIndex
CREATE INDEX "leaderboard_entries_period_category_pnlKes_idx" ON "leaderboard_entries"("period", "category", "pnlKes");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_entries_userId_period_category_key" ON "leaderboard_entries"("userId", "period", "category");

-- CreateIndex
CREATE INDEX "market_volumes_period_idx" ON "market_volumes"("period");

-- CreateIndex
CREATE UNIQUE INDEX "market_volumes_marketId_period_key" ON "market_volumes"("marketId", "period");

