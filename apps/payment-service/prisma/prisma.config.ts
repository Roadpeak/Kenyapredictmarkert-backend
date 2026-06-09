import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.PAYMENT_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/payment_db',
})
