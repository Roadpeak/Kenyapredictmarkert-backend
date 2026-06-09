import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/analytics_db',
})
