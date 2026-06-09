import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.TRADING_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/trading_db',
})
