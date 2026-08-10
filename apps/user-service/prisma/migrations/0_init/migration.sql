-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'PHONE_VERIFIED', 'ID_SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NONE',
    "kycTier" INTEGER NOT NULL DEFAULT 0,
    "withdrawLimit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "depositLimit" DECIMAL(15,2) NOT NULL DEFAULT 50000,
    "referralCode" TEXT NOT NULL,
    "referredBy" TEXT,
    "totalReferrals" INTEGER NOT NULL DEFAULT 0,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "docNumber" TEXT,
    "frontUrl" TEXT,
    "backUrl" TEXT,
    "selfieUrl" TEXT,
    "status" "DocStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "smsNotifications" BOOLEAN NOT NULL DEFAULT true,
    "pushNotifications" BOOLEAN NOT NULL DEFAULT true,
    "defaultCategory" TEXT,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_phone_key" ON "user_profiles"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_referralCode_key" ON "user_profiles"("referralCode");

-- CreateIndex
CREATE INDEX "kyc_documents_userId_idx" ON "kyc_documents"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

