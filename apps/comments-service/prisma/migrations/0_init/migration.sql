-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "gifUrl" TEXT,
    "gifId" TEXT,
    "stickerId" TEXT,
    "parentId" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comments_marketId_parentId_createdAt_idx" ON "comments"("marketId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "comments_userId_createdAt_idx" ON "comments"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

