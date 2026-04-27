/* eslint-disable no-console */
// Historical sweep: has the FB echo path EVER captured a HUMAN message
// on this account? Distinguishes "Daniel doesn't use FB phone" from
// "the FB echo path has never worked".

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } }
  });
  if (!account) {
    console.error('No daetradez account.');
    process.exit(1);
  }

  // 1. Any FB HUMAN message ever (regardless of humanSource)?
  const fbHumanCount = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    }
  });
  console.log(`FB HUMAN messages, all-time:                 ${fbHumanCount}`);

  // 2. Any FB HUMAN with humanSource=PHONE?
  const fbPhoneCount = await prisma.message.count({
    where: {
      sender: 'HUMAN',
      humanSource: 'PHONE',
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    }
  });
  console.log(`FB HUMAN/PHONE messages, all-time:           ${fbPhoneCount}`);

  // 3. Earliest + latest FB HUMAN row, if any.
  if (fbHumanCount > 0) {
    const earliest = await prisma.message.findFirst({
      where: {
        sender: 'HUMAN',
        conversation: {
          lead: { accountId: account.id, platform: 'FACEBOOK' }
        }
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, humanSource: true, content: true }
    });
    const latest = await prisma.message.findFirst({
      where: {
        sender: 'HUMAN',
        conversation: {
          lead: { accountId: account.id, platform: 'FACEBOOK' }
        }
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true, humanSource: true, content: true }
    });
    console.log(
      `\nEarliest FB HUMAN: ${earliest?.timestamp.toISOString()} ` +
        `humanSource=${earliest?.humanSource} "${earliest?.content.slice(0, 50)}"`
    );
    console.log(
      `Latest   FB HUMAN: ${latest?.timestamp.toISOString()} ` +
        `humanSource=${latest?.humanSource} "${latest?.content.slice(0, 50)}"`
    );
  }

  // 4. Are FB AI echoes being deduped successfully? Indirect proxy:
  //    count FB AI messages with non-null platformMessageId vs without.
  //    Meta sets platformMessageId on every echo it forwards. If our
  //    handler is matching echo→AI via the content-dedup path, the
  //    AI rows should have their platformMessageId backfilled.
  const fbAiTotal = await prisma.message.count({
    where: {
      sender: 'AI',
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    }
  });
  const fbAiWithPmid = await prisma.message.count({
    where: {
      sender: 'AI',
      platformMessageId: { not: null },
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    }
  });
  const fbAiPercent =
    fbAiTotal > 0 ? Math.round((fbAiWithPmid / fbAiTotal) * 100) : 0;
  console.log(
    `\nFB AI rows w/ platformMessageId: ${fbAiWithPmid}/${fbAiTotal} (${fbAiPercent}%)`
  );

  // 5. Same proxy for IG control.
  const igAiTotal = await prisma.message.count({
    where: {
      sender: 'AI',
      conversation: {
        lead: { accountId: account.id, platform: 'INSTAGRAM' }
      }
    }
  });
  const igAiWithPmid = await prisma.message.count({
    where: {
      sender: 'AI',
      platformMessageId: { not: null },
      conversation: {
        lead: { accountId: account.id, platform: 'INSTAGRAM' }
      }
    }
  });
  const igAiPercent =
    igAiTotal > 0 ? Math.round((igAiWithPmid / igAiTotal) * 100) : 0;
  console.log(
    `IG AI rows w/ platformMessageId: ${igAiWithPmid}/${igAiTotal} (${igAiPercent}%)`
  );

  // 6. FB inbound LEAD count over recent windows.
  const fbLead24h = await prisma.message.count({
    where: {
      sender: 'LEAD',
      timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      conversation: {
        lead: { accountId: account.id, platform: 'FACEBOOK' }
      }
    }
  });
  console.log(`\nFB LEAD inbounds, last 24h: ${fbLead24h}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
