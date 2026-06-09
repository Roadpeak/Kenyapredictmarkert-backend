import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.MARKET_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/market_db',
})
