/* eslint-disable no-console */
// Set a user's platform role so /admin loads (MANAGER = view/action all
// tenants; SUPER_ADMIN = everything incl. onboarding/billing). Idempotent.
//
// Usage (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/set-platform-role.ts <email> <MANAGER|SUPER_ADMIN|ADMIN> [--apply]
import 'dotenv/config';
import prisma from '@/lib/prisma';

const ROLES = new Set(['MANAGER', 'SUPER_ADMIN', 'ADMIN']);

async function main() {
  const [email, roleRaw] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  const role = (roleRaw ?? '').toUpperCase();
  if (!email || !ROLES.has(role)) {
    console.error(
      'usage: set-platform-role.ts <email> <MANAGER|SUPER_ADMIN|ADMIN> [--apply]'
    );
    process.exit(1);
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      account: { select: { name: true } }
    }
  });
  if (!user) {
    console.error(`no user with email=${email}`);
    process.exit(1);
  }
  console.log(
    `${user.email} (${user.name}) role=${user.role} active=${user.isActive} workspace=${user.account?.name}`
  );
  if (user.role === role) {
    console.log(`already ${role}, nothing to do`);
    return;
  }
  if (!apply) {
    console.log(`would set role ${user.role} -> ${role} (re-run with --apply)`);
    return;
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: role as never },
    select: { role: true }
  });
  console.log(`updated: role ${user.role} -> ${updated.role}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
