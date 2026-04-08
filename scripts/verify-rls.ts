/**
 * Verify Row-Level Security is enabled on every public schema table.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/verify-rls.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TableRow {
  tablename: string;
  rowsecurity: boolean;
}

async function main() {
  const rows = await prisma.$queryRawUnsafe<TableRow[]>(
    `SELECT tablename, rowsecurity
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename;`
  );

  console.log(`\nFound ${rows.length} tables in public schema:\n`);
  console.log('  RLS  | Table');
  console.log('  ---- | -----');

  let rlsEnabled = 0;
  let rlsDisabled = 0;

  for (const r of rows) {
    const flag = r.rowsecurity ? '  ON ' : ' OFF ';
    console.log(`  ${flag} | ${r.tablename}`);
    if (r.rowsecurity) rlsEnabled++;
    else rlsDisabled++;
  }

  console.log(`\nSummary: ${rlsEnabled} ON, ${rlsDisabled} OFF`);

  if (rlsDisabled > 0) {
    console.error(
      '\n⚠  Some tables still have RLS disabled — security is NOT fully closed.'
    );
    process.exit(1);
  } else {
    console.log('\n✔  RLS is enabled on every public table.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
