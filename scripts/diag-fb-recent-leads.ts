/* eslint-disable no-console */
// Cross-check: most recent FB LEAD messages in the DB vs the Vercel
// log line "Are you a trader bro?" at 15:21:10 UTC. If the DB has it,
// inbound flow is fine. If not, save path is broken.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const rows = await prisma.message.findMany({
    where: {
      sender: 'LEAD',
      timestamp: { gte: since },
      conversation: { lead: { platform: 'FACEBOOK' } }
    },
    orderBy: { timestamp: 'desc' },
    take: 20,
    include: {
      conversation: {
        select: {
          lead: {
            select: { name: true, handle: true, platformUserId: true }
          }
        }
      }
    }
  });

  console.log(
    `FB LEAD messages in last 30 min (${rows.length}, most recent first):\n`
  );
  for (const r of rows) {
    const lead = r.conversation.lead;
    console.log(
      `${r.timestamp.toISOString()} pUid=${lead.platformUserId} ` +
        `${(lead.name || '').slice(0, 18).padEnd(20)} "${r.content.slice(0, 70)}"`
    );
  }

  // Also: any FB AI sends in the last 30 min — are we still sending out?
  const aiOut = await prisma.message.count({
    where: {
      sender: 'AI',
      timestamp: { gte: since },
      conversation: { lead: { platform: 'FACEBOOK' } }
    }
  });
  console.log(`\nFB AI sends in last 30 min: ${aiOut}`);

  // Any FB HUMAN/PHONE in last 30 min?
  const phoneEcho = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      timestamp: { gte: since },
      conversation: { lead: { platform: 'FACEBOOK' } }
    }
  });
  console.log(`FB HUMAN/PHONE in last 30 min: ${phoneEcho}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
