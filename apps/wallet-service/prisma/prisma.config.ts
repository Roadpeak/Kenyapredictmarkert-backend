import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.WALLET_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wallet_db',
})
