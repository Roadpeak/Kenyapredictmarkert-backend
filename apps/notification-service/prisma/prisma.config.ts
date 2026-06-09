import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.NOTIFICATION_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/notification_db',
})
