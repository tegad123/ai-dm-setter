// Repair leads whose `name` was corrupted with a chat-message body (the
// message-body-as-name bug). Restores name from handle where name looks like a
// message and handle is a usable display value.
//
// DRY-RUN by default. Pass --apply to write. Targets PROD_DATABASE_URL when
// --prod is passed, otherwise local DATABASE_URL.
//
//   npx tsx scripts/repair-message-body-lead-names.ts            # dry-run, local
//   npx tsx scripts/repair-message-body-lead-names.ts --prod     # dry-run, prod
//   npx tsx scripts/repair-message-body-lead-names.ts --prod --apply
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { looksLikeMessageBody } from '../src/lib/lead-name';

const useProd = process.argv.includes('--prod');
const apply = process.argv.includes('--apply');
const url = useProd ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url } } });

async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
}

(async () => {
  console.log(
    `Target: ${useProd ? 'PROD' : 'LOCAL'} | mode: ${apply ? 'APPLY (writes)' : 'DRY-RUN'}`
  );
  // Candidate filter narrows the scan; the JS heuristic is the source of truth.
  const candidates = await retry(() =>
    db.lead.findMany({
      where: {
        OR: [
          { name: { contains: '?' } },
          { name: { contains: ' ', mode: 'insensitive' } }
        ]
      },
      select: { id: true, name: true, handle: true, platformUserId: true }
    })
  );

  const corrupted = candidates.filter(
    (l) =>
      looksLikeMessageBody(l.name) &&
      l.handle &&
      !looksLikeMessageBody(l.handle)
  );

  console.log(
    `Scanned ${candidates.length} candidates → ${corrupted.length} corrupted (name looks like a message, handle is usable).`
  );
  for (const l of corrupted) {
    console.log(`  ${l.id}: "${l.name}"  →  "${l.handle}"`);
  }

  if (!apply) {
    console.log('\nDRY-RUN only. Re-run with --apply to write these changes.');
    await db.$disconnect();
    return;
  }

  let fixed = 0;
  for (const l of corrupted) {
    await retry(() =>
      db.lead.update({ where: { id: l.id }, data: { name: l.handle! } })
    );
    fixed++;
  }
  console.log(`\nRepaired ${fixed} lead name(s).`);
  await db.$disconnect();
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await db.$disconnect();
  process.exit(1);
});
