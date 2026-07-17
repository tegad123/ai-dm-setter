// Sets the {{WEBSITE_LINK}} for the DAETRADEZ low-ticket funnel — the step-8
// "Funnel to Website" send_link action. The audit found no website URL exists
// anywhere in config, so the funnel's terminal action delivered nothing.
//
// Per Tega: dummy URL for verification (https://example.com/dae-funnel);
// the REAL URL from Daniel is swapped in with the same command before launch.
// The URL lands in both `content` and `linkUrl` of the action so the
// serializer ships it verbatim and getAllowedUrls allowlists it.
//
// Usage: npx tsx scripts/set-dae-website-link.ts https://example.com/dae-funnel
//        npx tsx scripts/set-dae-website-link.ts --verify

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const ACCOUNT_ID = 'cmpy59zy50000ju04u6fs5o2r';

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('usage: set-dae-website-link.ts <url> | --verify');

  const script = await prisma.script.findFirst({
    where: { accountId: ACCOUNT_ID, isActive: true },
    select: {
      id: true,
      name: true,
      steps: {
        where: { stepNumber: 8 },
        select: {
          stepNumber: true,
          title: true,
          branches: {
            select: {
              branchLabel: true,
              actions: {
                where: { actionType: 'send_link' },
                select: { id: true, content: true, linkUrl: true }
              }
            }
          }
        }
      }
    }
  });
  if (!script) throw new Error('active script not found');
  const step8 = script.steps[0];
  if (!step8) throw new Error('step 8 not found');

  const linkActions = step8.branches.flatMap((b) =>
    b.actions.map((a) => ({ branch: b.branchLabel, ...a }))
  );
  console.log(`script "${script.name}" — step 8 "${step8.title}"`);
  console.log('BEFORE:');
  linkActions.forEach((a) =>
    console.log(
      `  [${a.branch}] send_link id=${a.id} content="${a.content}" linkUrl=${a.linkUrl ?? 'null'}`
    )
  );

  if (arg === '--verify') {
    await prisma.$disconnect();
    return;
  }

  if (!/^https?:\/\//i.test(arg)) throw new Error('not a valid URL: ' + arg);

  for (const a of linkActions) {
    await prisma.scriptAction.update({
      where: { id: a.id },
      data: { content: arg, linkUrl: arg }
    });
  }

  const after = await prisma.scriptAction.findMany({
    where: { id: { in: linkActions.map((a) => a.id) } },
    select: { id: true, content: true, linkUrl: true }
  });
  console.log('\nAFTER:');
  after.forEach((a) =>
    console.log(`  id=${a.id} content="${a.content}" linkUrl=${a.linkUrl}`)
  );
  console.log(
    '\nWEBSITE LINK SET. Remember: dummy does NOT go live on real leads — swap the real URL before launch.'
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
