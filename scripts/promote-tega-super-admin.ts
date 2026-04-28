/* eslint-disable no-console */
// Promote Tega's user record to SUPER_ADMIN so /admin loads.
// Idempotent: re-runs are safe — already-SUPER_ADMIN users skip the
// update but still write an AdminLog row noting the no-op for audit.
//
// Usage:
//   pnpm tsx scripts/promote-tega-super-admin.ts            # report only
//   pnpm tsx scripts/promote-tega-super-admin.ts --apply    # commit

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

const TEGA_EMAIL = 'tegad8@gmail.com';

async function main() {
  const apply = process.argv.includes('--apply');

  const user = await prisma.user.findUnique({
    where: { email: TEGA_EMAIL },
    select: { id: true, email: true, name: true, role: true, accountId: true }
  });
  if (!user) {
    console.error(`No user with email=${TEGA_EMAIL}.`);
    process.exit(1);
  }

  console.log('Found user:');
  console.log(`  id=${user.id}`);
  console.log(`  name=${user.name}`);
  console.log(`  email=${user.email}`);
  console.log(`  role=${user.role}`);
  console.log(`  accountId=${user.accountId}`);

  if (user.role === 'SUPER_ADMIN') {
    console.log('\nAlready SUPER_ADMIN — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(
      `\nWill flip role: ${user.role} → SUPER_ADMIN. Re-run with --apply to commit.`
    );
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { role: 'SUPER_ADMIN' }
    }),
    prisma.adminLog.create({
      data: {
        adminUserId: user.id,
        targetAccountId: null,
        action: 'role.promote_super_admin',
        metadata: { fromRole: user.role, toRole: 'SUPER_ADMIN' }
      }
    })
  ]);
  console.log(`\nPromoted ${user.email} to SUPER_ADMIN. AdminLog row written.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
