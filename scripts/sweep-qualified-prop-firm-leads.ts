/**
 * Identifies VERIFIED_QUALIFIED conversations with null capitalVerifiedAmount
 * that were likely contaminated by the prop-firm / bare-affirmative bug.
 *
 * REVIEW-ONLY by default. Pass --write to update affected rows to UNVERIFIED.
 */
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(process.cwd(), '.env'), override: true });

const WRITE_MODE = process.argv.includes('--write');

const PROP_FIRM_PATTERN =
  /\b(ftmo|topstep|apex|myforexfunds|mff|e8\s*funding|funded\s*trader|funded\s*account|prop\s*firm|prop\s*trading|proprietary\s*trading|challenge\s*account|funded\s*futures|earn2trade|the\s*funded\s*trader|blue\s*guardian|funder\s*trading|instant\s*funding|true\s*forex\s*funds|the\s*5%\s*ers?|5%\s*ers?|forex\s*prop|prop\s*fund|prop\s*money|3commas|bulenox|lux\s*trading|traders\+|ufunded)\b/i;
const PERSONAL_CAPITAL_INDICATOR =
  /\b(i\s+(have|got|saved|put|set)|i'?ve\s+(got|saved|put|set)|my\s+(savings|personal|own|capital|money|side))\b/i;
const PLUS_PHRASE =
  /\b(plus|also|on\s+top\s+of|besides|separate\s+from|aside\s+from|in\s+addition\s+to|as\s+well\s+as)\b/i;

const prodUrl = (process.env.PROD_DATABASE_URL ?? '')
  .replace(':6543/', ':5432/')
  .replace('?pgbouncer=true', '');

const p = new PrismaClient({ datasources: { db: { url: prodUrl } }, log: [] });

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

async function main() {
  console.log(
    `MODE: ${WRITE_MODE ? 'WRITE (will update DB)' : 'READ-ONLY (pass --write to update)'}\n`
  );

  const convs = await retry(() =>
    p.conversation.findMany({
      where: {
        capitalVerificationStatus: 'VERIFIED_QUALIFIED',
        capitalVerifiedAmount: null
      },
      select: {
        id: true,
        systemStage: true,
        capitalVerificationStatus: true,
        capitalVerifiedAmount: true,
        lead: { select: { handle: true, name: true } },
        messages: {
          where: { sender: 'LEAD' },
          select: { id: true, content: true, timestamp: true },
          orderBy: { timestamp: 'asc' }
        }
      }
    })
  );

  console.log(
    `Found ${convs.length} VERIFIED_QUALIFIED conversations with null capitalVerifiedAmount\n`
  );

  const propFirmContaminated: string[] = [];
  const noSignal: string[] = [];

  for (const conv of convs) {
    const leadName = conv.lead?.name || conv.lead?.handle || 'unknown';
    const msgs = conv.messages;

    const hasPropFirmMsg = msgs.some(
      (m) =>
        PROP_FIRM_PATTERN.test(m.content) &&
        !PERSONAL_CAPITAL_INDICATOR.test(m.content) &&
        !PLUS_PHRASE.test(m.content)
    );

    const propFirmMsgs = msgs
      .filter((m) => PROP_FIRM_PATTERN.test(m.content))
      .map(
        (m) => `  [${m.timestamp.toISOString()}] "${m.content.slice(0, 120)}"`
      );

    const tag = hasPropFirmMsg
      ? 'PROP_FIRM_CONTAMINATED'
      : 'no_prop_firm_signal';

    console.log(`Conv: ${conv.id}`);
    console.log(`  Lead: ${leadName}`);
    console.log(`  Stage: ${conv.systemStage}`);
    console.log(`  Tag: ${tag}`);
    if (propFirmMsgs.length > 0) {
      console.log(`  Prop-firm messages:`);
      propFirmMsgs.forEach((m) => console.log(m));
    }
    console.log('');

    if (hasPropFirmMsg) {
      propFirmContaminated.push(conv.id);
    } else {
      noSignal.push(conv.id);
    }
  }

  console.log('--- SUMMARY ---');
  console.log(
    `Prop-firm contaminated (should reset to UNVERIFIED): ${propFirmContaminated.length}`
  );
  console.log(
    `No prop-firm signal (keep VERIFIED_QUALIFIED):       ${noSignal.length}`
  );
  console.log('');

  if (propFirmContaminated.length === 0) {
    console.log('Nothing to update.');
    await p.$disconnect();
    return;
  }

  if (!WRITE_MODE) {
    console.log(`IDs to reset: ${propFirmContaminated.join(', ')}`);
    console.log('\nRe-run with --write to apply changes.');
    await p.$disconnect();
    return;
  }

  console.log('Writing UNVERIFIED to DB...');
  const result = await retry(() =>
    p.conversation.updateMany({
      where: { id: { in: propFirmContaminated } },
      data: { capitalVerificationStatus: 'UNVERIFIED' }
    })
  );
  console.log(`Updated ${result.count} conversations → UNVERIFIED.`);
  await p.$disconnect();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  p.$disconnect();
  process.exit(1);
});
