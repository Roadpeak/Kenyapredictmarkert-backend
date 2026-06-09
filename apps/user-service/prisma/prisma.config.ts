import { defineConfig } from 'prisma/config'

export default defineConfig({
  datasourceUrl: process.env.USER_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/user_db',
})
