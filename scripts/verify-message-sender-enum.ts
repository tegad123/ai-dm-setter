/* eslint-disable no-console */
import prisma from '../src/lib/prisma';

async function main() {
  const rows = await prisma.$queryRawUnsafe<{ unnest: string }[]>(
    'SELECT unnest(enum_range(NULL::"MessageSender"))::text AS unnest'
  );
  console.log(rows.map((r) => r.unnest));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
