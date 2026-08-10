-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('YES', 'NO');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SETTLED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "market_pools" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "poolYesKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "poolNoKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalShares" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "yesShares" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "noShares" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rake" DECIMAL(4,3) NOT NULL DEFAULT 0.04,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "sharesReceived" DECIMAL(18,6) NOT NULL,
    "pricePerShare" DECIMAL(6,4) NOT NULL,
    "poolYesAtTrade" DECIMAL(15,2) NOT NULL,
    "poolNoAtTrade" DECIMAL(15,2) NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "payoutKes" DECIMAL(15,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_pools" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "poolKes" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "totalShares" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rake" DECIMAL(4,3) NOT NULL DEFAULT 0.04,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "totalShares" DECIMAL(18,6) NOT NULL,
    "totalCostKes" DECIMAL(15,2) NOT NULL,
    "avgPriceKes" DECIMAL(6,4) NOT NULL,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "payoutKes" DECIMAL(15,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_trades" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountKes" DECIMAL(15,2) NOT NULL,
    "sharesReceived" DECIMAL(18,6) NOT NULL,
    "pricePerShare" DECIMAL(6,4) NOT NULL,
    "poolAtTrade" DECIMAL(15,2) NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "payoutKes" DECIMAL(15,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "totalShares" DECIMAL(18,6) NOT NULL,
    "totalCostKes" DECIMAL(15,2) NOT NULL,
    "avgPriceKes" DECIMAL(6,4) NOT NULL,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "payoutKes" DECIMAL(15,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outcome" "Outcome" NOT NULL,
    "sharesHeld" DECIMAL(18,6) NOT NULL,
    "payoutKes" DECIMAL(15,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_pools_marketId_key" ON "market_pools"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "trades_idempotencyKey_key" ON "trades"("idempotencyKey");

-- CreateIndex
CREATE INDEX "trades_userId_marketId_idx" ON "trades"("userId", "marketId");

-- CreateIndex
CREATE INDEX "trades_marketId_createdAt_idx" ON "trades"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "trades_userId_createdAt_idx" ON "trades"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "option_pools_optionId_key" ON "option_pools"("optionId");

-- CreateIndex
CREATE INDEX "option_pools_marketId_idx" ON "option_pools"("marketId");

-- CreateIndex
CREATE INDEX "option_positions_marketId_isSettled_idx" ON "option_positions"("marketId", "isSettled");

-- CreateIndex
CREATE INDEX "option_positions_userId_idx" ON "option_positions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "option_positions_userId_optionId_key" ON "option_positions"("userId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "option_trades_idempotencyKey_key" ON "option_trades"("idempotencyKey");

-- CreateIndex
CREATE INDEX "option_trades_marketId_createdAt_idx" ON "option_trades"("marketId", "createdAt");

-- CreateIndex
CREATE INDEX "option_trades_userId_createdAt_idx" ON "option_trades"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "positions_marketId_idx" ON "positions"("marketId");

-- CreateIndex
CREATE INDEX "positions_userId_idx" ON "positions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "positions_userId_marketId_outcome_key" ON "positions"("userId", "marketId", "outcome");

-- CreateIndex
CREATE INDEX "settlements_marketId_idx" ON "settlements"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_marketId_userId_outcome_key" ON "settlements"("marketId", "userId", "outcome");

