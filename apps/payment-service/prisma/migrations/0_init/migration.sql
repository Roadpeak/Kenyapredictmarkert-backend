-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING_MPESA', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "amountKes" DECIMAL(15,2) NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "merchantRequestId" TEXT,
    "checkoutRequestId" TEXT,
    "mpesaReceiptNumber" TEXT,
    "conversationId" TEXT,
    "originatorConvId" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callbacks" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mpesa_credentials" (
    "id" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "consumerKey" TEXT NOT NULL,
    "consumerSecret" TEXT NOT NULL,
    "accessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mpesa_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_limit_trackers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "deposited" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "withdrawn" DECIMAL(15,2) NOT NULL DEFAULT 0,

    CONSTRAINT "daily_limit_trackers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_userId_status_idx" ON "payments"("userId", "status");

-- CreateIndex
CREATE INDEX "payments_merchantRequestId_idx" ON "payments"("merchantRequestId");

-- CreateIndex
CREATE INDEX "payments_checkoutRequestId_idx" ON "payments"("checkoutRequestId");

-- CreateIndex
CREATE INDEX "payments_mpesaReceiptNumber_idx" ON "payments"("mpesaReceiptNumber");

-- CreateIndex
CREATE INDEX "payment_callbacks_paymentId_idx" ON "payment_callbacks"("paymentId");

-- CreateIndex
CREATE INDEX "daily_limit_trackers_userId_idx" ON "daily_limit_trackers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "daily_limit_trackers_userId_date_key" ON "daily_limit_trackers"("userId", "date");

-- AddForeignKey
ALTER TABLE "payment_callbacks" ADD CONSTRAINT "payment_callbacks_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

