/* eslint-disable no-console */
// Reports HUMAN/PHONE messages on FACEBOOK leads (any account) in the
// last 10 minutes. Used to confirm message_echoes subscription is
// actually flowing echoes through to the DB.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const rows = await prisma.message.findMany({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      timestamp: { gte: since },
      conversation: { lead: { platform: 'FACEBOOK' } }
    },
    orderBy: { timestamp: 'desc' },
    include: {
      conversation: {
        select: {
          lead: {
            select: {
              accountId: true,
              name: true,
              handle: true,
              platform: true
            }
          }
        }
      }
    }
  });

  console.log(
    `Window: last 10 minutes (>= ${since.toISOString()}) — FACEBOOK + HUMAN + humanSource=PHONE`
  );
  console.log(`Match count: ${rows.length}\n`);
  for (const r of rows) {
    const lead = r.conversation.lead;
    console.log(
      `  ${r.timestamp.toISOString()} acct=${lead.accountId.slice(0, 14)}… ` +
        `${lead.name} (@${lead.handle}) → "${r.content.slice(0, 80)}"`
    );
  }

  // For comparison context — also count last 24h and INSTAGRAM in
  // the same window so the operator can see whether *any* echoes are
  // landing on FB (helps distinguish "subscription works but no
  // operator phone activity right now" from "subscription broken").
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fb24h = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      timestamp: { gte: since24h },
      conversation: { lead: { platform: 'FACEBOOK' } }
    }
  });
  const ig10min = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      timestamp: { gte: since },
      conversation: { lead: { platform: 'INSTAGRAM' } }
    }
  });
  console.log(`\n── Comparison context ──`);
  console.log(`  FACEBOOK PHONE in last 24h:   ${fb24h}`);
  console.log(`  INSTAGRAM PHONE in last 10min: ${ig10min}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
