-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'RESOLVED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('BINARY', 'MULTI');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "ResolutionType" AS ENUM ('MANUAL', 'AUTOMATED_FEED', 'ORACLE');

-- CreateEnum
CREATE TYPE "FeedType" AS ENUM ('SPORTS_API', 'NEWS_SCRAPER', 'MANUAL_ORACLE', 'CRYPTO_PRICE', 'WEATHER_API');

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "longDescription" TEXT,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "imageUrl" TEXT,
    "sourceUrl" TEXT,
    "status" "MarketStatus" NOT NULL DEFAULT 'DRAFT',
    "resolution" "ResolutionType" NOT NULL DEFAULT 'MANUAL',
    "openAt" TIMESTAMP(3) NOT NULL,
    "closeAt" TIMESTAMP(3) NOT NULL,
    "resolveAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedOutcome" "Outcome",
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "poolYesKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "poolNoKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "rake" DECIMAL(4,3) NOT NULL DEFAULT 0.04,
    "seedYesKes" DECIMAL(15,2) NOT NULL DEFAULT 1000,
    "seedNoKes" DECIMAL(15,2) NOT NULL DEFAULT 1000,
    "createdBy" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL DEFAULT 'BINARY',

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_options" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "poolKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "seedKes" DECIMAL(15,2) NOT NULL DEFAULT 1000,
    "totalShares" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "market_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_outcomes" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "label" "Outcome" NOT NULL,

    CONSTRAINT "market_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesPrice" DECIMAL(6,4) NOT NULL,
    "noPrice" DECIMAL(6,4) NOT NULL,
    "volume" DECIMAL(15,2) NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_price_snapshots" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "price" DECIMAL(6,4) NOT NULL,
    "poolKes" DECIMAL(15,2) NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_configs" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "feedType" "FeedType" NOT NULL,
    "feedSource" TEXT NOT NULL,
    "feedQuery" JSONB NOT NULL,
    "lastChecked" TIMESTAMP(3),
    "lastResult" JSONB,

    CONSTRAINT "feed_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "markets_slug_key" ON "markets"("slug");

-- CreateIndex
CREATE INDEX "markets_status_category_idx" ON "markets"("status", "category");

-- CreateIndex
CREATE INDEX "markets_closeAt_idx" ON "markets"("closeAt");

-- CreateIndex
CREATE INDEX "markets_slug_idx" ON "markets"("slug");

-- CreateIndex
CREATE INDEX "market_options_marketId_idx" ON "market_options"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "market_options_marketId_label_key" ON "market_options"("marketId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "market_outcomes_marketId_label_key" ON "market_outcomes"("marketId", "label");

-- CreateIndex
CREATE INDEX "price_snapshots_marketId_snapshotAt_idx" ON "price_snapshots"("marketId", "snapshotAt");

-- CreateIndex
CREATE INDEX "option_price_snapshots_marketId_snapshotAt_idx" ON "option_price_snapshots"("marketId", "snapshotAt");

-- CreateIndex
CREATE INDEX "option_price_snapshots_optionId_snapshotAt_idx" ON "option_price_snapshots"("optionId", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "feed_configs_marketId_key" ON "feed_configs"("marketId");

-- AddForeignKey
ALTER TABLE "market_options" ADD CONSTRAINT "market_options_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_outcomes" ADD CONSTRAINT "market_outcomes_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_price_snapshots" ADD CONSTRAINT "option_price_snapshots_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_configs" ADD CONSTRAINT "feed_configs_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

