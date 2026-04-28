/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const a = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: {
      id: true,
      slug: true,
      responseDelayMin: true,
      responseDelayMax: true,
      debounceWindowSeconds: true,
      maxDebounceWindowSeconds: true,
      personas: {
        where: { isActive: true },
        select: {
          id: true,
          responseDelayMin: true,
          responseDelayMax: true
        }
      }
    }
  });
  console.log(JSON.stringify(a, null, 2));
  await prisma.$disconnect();
}
main();
