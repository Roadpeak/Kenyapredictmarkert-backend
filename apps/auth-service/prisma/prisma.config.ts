import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.AUTH_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/auth_db',
})
