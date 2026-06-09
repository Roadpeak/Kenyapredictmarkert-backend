/**
 * Seed script: creates an ADMIN user for E2E tests.
 *
 * Usage:
 *   pnpm exec ts-node -P tsconfig.base.json scripts/seed-admin.ts
 *
 * Reads AUTH_DATABASE_URL from .env
 * Outputs: ADMIN_PHONE and ADMIN_TOKEN env vars to copy into .env.test
 */
import { PrismaClient as AuthPrisma } from '.prisma/auth-client';
import * as bcrypt from 'bcryptjs';

const prisma = new AuthPrisma();

const ADMIN_PHONE = process.env.SEED_ADMIN_PHONE ?? '0700000001';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'AdminPass123';

async function main() {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const user = await prisma.user.upsert({
    where: { phone: ADMIN_PHONE },
    update: { role: 'ADMIN', isPhoneVerified: true, passwordHash: hash },
    create: {
      phone: ADMIN_PHONE,
      passwordHash: hash,
      role: 'ADMIN',
      isPhoneVerified: true,
    },
  });

  console.log('Admin user seeded:');
  console.log('  phone   :', ADMIN_PHONE);
  console.log('  password:', ADMIN_PASSWORD);
  console.log('  id      :', user.id);
  console.log('');
  console.log('Now login to get a token:');
  console.log(
    `  curl -s -X POST http://localhost:3000/auth/login \\`,
  );
  console.log(
    `    -H 'Content-Type: application/json' \\`,
  );
  console.log(
    `    -d '{"phone":"${ADMIN_PHONE}","password":"${ADMIN_PASSWORD}"}' | jq .accessToken`,
  );
  console.log('');
  console.log('Then export for E2E:');
  console.log(`  export ADMIN_PHONE=${ADMIN_PHONE}`);
  console.log(`  export ADMIN_TOKEN=<paste token here>`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
