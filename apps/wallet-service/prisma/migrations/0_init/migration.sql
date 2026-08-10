-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE_RESERVE', 'TRADE_RELEASE', 'TRADE_DEBIT', 'PAYOUT', 'REFUND', 'RAKE_DEBIT', 'BONUS_CREDIT', 'REFERRAL_BONUS');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "reservedBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lifetimeDeposit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lifetimeWithdraw" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "lifetimePayout" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "direction" "Direction" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "balanceBefore" DECIMAL(15,2) NOT NULL,
    "balanceAfter" DECIMAL(15,2) NOT NULL,
    "referenceId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "ledger_entries_walletId_createdAt_idx" ON "ledger_entries"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_type_idx" ON "ledger_entries"("userId", "type");

-- CreateIndex
CREATE INDEX "ledger_entries_referenceId_idx" ON "ledger_entries"("referenceId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

