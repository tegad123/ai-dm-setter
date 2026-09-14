// Toggle per-platform Away Mode (AI auto-send) for a workspace.
//
// Away Mode ON = the AI auto-sends on that platform (subject to the egress
// gate and generate-only). It is one of the two go-live settings: with it OFF
// and generate-only OFF, new leads get aiActive=false and nothing auto-sends.
// Turning it ON runs the same orphan-suggestion rescue the dashboard toggle
// runs (leads who wrote in the last 30 min and are waiting get a reply
// scheduled; under generate-only that lands as a suggestion).
//
// Usage:
//   DATABASE_URL=$PROD_DATABASE_URL NODE_PATH=$PWD/node_modules \
//     npx tsx scripts/set-away-mode.ts <accountId> <INSTAGRAM|FACEBOOK> <on|off>

import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

import prisma from '../src/lib/prisma';

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Can't reach|ECONNRESET|timeout|pooler/i.test(msg)) throw e;
      console.warn(
        `transient DB error (attempt ${i + 1}/${tries}): ${msg.split('\n')[0]}`
      );
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

async function main() {
  const [accountId, platformRaw, stateRaw] = process.argv.slice(2);
  const platform = (platformRaw ?? '').toUpperCase();
  const state = (stateRaw ?? '').toLowerCase();
  if (
    !accountId ||
    (platform !== 'INSTAGRAM' && platform !== 'FACEBOOK') ||
    (state !== 'on' && state !== 'off')
  ) {
    console.error(
      'usage: set-away-mode.ts <accountId> <INSTAGRAM|FACEBOOK> <on|off>'
    );
    process.exit(2);
  }
  const on = state === 'on';
  const now = new Date();
  const before = await withRetry(() =>
    prisma.account.findUnique({
      where: { id: accountId },
      select: {
        name: true,
        awayModeInstagram: true,
        awayModeFacebook: true,
        generateOnlyInstagram: true,
        generateOnlyFacebook: true
      }
    })
  );
  if (!before) throw new Error(`account ${accountId} not found`);
  const data =
    platform === 'INSTAGRAM'
      ? { awayModeInstagram: on, awayModeInstagramEnabledAt: on ? now : null }
      : { awayModeFacebook: on, awayModeFacebookEnabledAt: on ? now : null };
  const updated = await withRetry(() =>
    prisma.account.update({
      where: { id: accountId },
      data: {
        ...data,
        awayMode:
          platform === 'INSTAGRAM'
            ? on || before.awayModeFacebook
            : on || before.awayModeInstagram
      },
      select: {
        awayModeInstagram: true,
        awayModeFacebook: true,
        generateOnlyInstagram: true,
        generateOnlyFacebook: true
      }
    })
  );
  const awayField =
    platform === 'INSTAGRAM' ? 'awayModeInstagram' : 'awayModeFacebook';
  const genField =
    platform === 'INSTAGRAM' ? 'generateOnlyInstagram' : 'generateOnlyFacebook';
  console.log(
    `${before.name} (${accountId}) ${platform} away mode: ${String(before[awayField])} → ${String(updated[awayField])} (generate-only ${String(updated[genField])})`
  );
  if (on) {
    const { rescueOrphanAISuggestions } = await import(
      '../src/lib/webhook-processor'
    );
    const r = await rescueOrphanAISuggestions(
      accountId,
      platform as 'INSTAGRAM' | 'FACEBOOK'
    );
    console.log(
      `orphan rescue: candidates=${r.candidates} dispatched=${r.dispatched} skipped=${r.skipped}`
    );
    if (updated[genField])
      console.log(
        'generate-only is ON: nothing delivers until it is turned off.'
      );
    else console.log(`LIVE: the AI now auto-sends on ${platform}.`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
