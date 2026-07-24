// Deletes known test/fake leads from Daniel Elumelu's account.
// Safe to re-run — skips any already-deleted lead silently.
//
// Usage: npx tsx scripts/delete-daniel-test-leads.ts

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const p = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});

async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

// Leads to delete from Daniel Elumelu's Workspace (cmpy59zy50000ju04u6fs5o2r)
// Add more rows here whenever new test leads need tracking.
const TARGETS = [
  { id: 'cmrdyh8yb006sl5049fqocrcr', name: 'Hamza Ali', handle: '@Hamza Ali' },
  {
    id: 'cmrdvvnf6000pl5042ktzve38',
    name: 'Ahmed Shah',
    handle: '@Ahmed Shah'
  },
  {
    id: 'cmrdg4i0x0001l404wfo9it1l',
    name: 'Shárúkh Sháh',
    handle: '@Shárúkh Sháh'
  },
  { id: 'cmr80swoj006hl704viku98tz', name: 'Ahsan Ali', handle: '@Ahsan Ali' },
  { id: 'cmq83xdgu0001if04mp2k4nir', name: 'Ali Hamza', handle: '@a7_hmz7' },
  { id: 'cmr7zl19y000pl7049c6vk0qb', name: 'Ali Hamza', handle: '@Ali Hamza' },
  { id: 'cmr7uueo1000ple049jkork51', name: 'ALi Raza', handle: '@ALi Raza' },
  {
    id: 'cmpzhrlq200edjr04itoymq0z',
    name: 'Ali Hassan',
    handle: '@mralihasan44'
  }
];

async function main() {
  for (const t of TARGETS) {
    const lead = await retry(() =>
      p.lead.findUnique({ where: { id: t.id }, select: { id: true } })
    );
    if (!lead) {
      console.log(`SKIP (already gone): ${t.name} ${t.handle}`);
      continue;
    }
    const convs = await retry(() =>
      p.conversation.findMany({ where: { leadId: t.id }, select: { id: true } })
    );
    for (const c of convs) {
      await retry(() =>
        p.message.deleteMany({ where: { conversationId: c.id } })
      );
      await retry(() =>
        p.scheduledReply.deleteMany({ where: { conversationId: c.id } })
      );
      await retry(() =>
        p.aISuggestion
          .deleteMany({ where: { conversationId: c.id } })
          .catch(() => {})
      );
    }
    await retry(() => p.conversation.deleteMany({ where: { leadId: t.id } }));
    await retry(() => p.lead.delete({ where: { id: t.id } }));
    console.log(`DELETED: ${t.name} ${t.handle} (${t.id})`);
  }
  await p.$disconnect();
  console.log('Done.');
}

main().catch(async (e) => {
  console.error('FATAL:', e.message);
  await p.$disconnect();
});
