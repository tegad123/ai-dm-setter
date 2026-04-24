/**
 * Backfill follow-ups for daetradez leads stuck in booking limbo.
 *
 * Target: conversations where the AI shipped the Typeform URL in the
 * last 7 days, lead.stage is still CALL_PROPOSED, no scheduledCallAt,
 * no pending FOLLOW_UP or BOOKING_LINK_FOLLOWUP row. Only aiActive=true
 * convos get scheduled — paused convos are left for the /toggle-ai
 * re-enable hook to pick up.
 *
 * Wait-time tiers (measured from the Typeform send, not from the
 * current moment, so a lead who replied 30min ago but got Typeform
 * 4 days ago is still treated as a soft-exit candidate):
 *   < 24h  → FOLLOW_UP_1          (booking body, +30min)
 *   24-72h → FOLLOW_UP_2          (booking body, +30min)
 *   > 72h  → FOLLOW_UP_SOFT_EXIT  (booking body, +30min)
 *
 * Dry-run by default (DRY=1). Set DRY=0 to actually insert rows.
 *
 * Run:
 *   npx tsx scripts/backfill-booking-limbo-followups.ts          # dry
 *   DRY=0 npx tsx scripts/backfill-booking-limbo-followups.ts    # live
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import {
  BOOKING_FOLLOW_UP_BODIES,
  TYPEFORM_BOOKING_URL
} from '../src/lib/follow-up-sequence';
import type { ScheduledMessageType } from '@prisma/client';

const DRY = process.env.DRY !== '0';
const LOOKBACK_DAYS = 7;
const FIRE_DELAY_MS = 30 * 60 * 1000; // +30 min
const H24 = 24 * 60 * 60 * 1000;
const H72 = 72 * 60 * 60 * 1000;

function pickTier(waitMs: number): ScheduledMessageType {
  if (waitMs < H24) return 'FOLLOW_UP_1';
  if (waitMs < H72) return 'FOLLOW_UP_2';
  return 'FOLLOW_UP_SOFT_EXIT';
}

async function main() {
  console.log(`DRY=${DRY ? 'yes (no inserts)' : 'no (will insert rows)'}\n`);

  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  if (!account) {
    console.error('daetradez account not found');
    process.exit(1);
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const typeformSends = await prisma.message.findMany({
    where: {
      sender: 'AI',
      timestamp: { gte: since },
      content: { contains: TYPEFORM_BOOKING_URL },
      conversation: { lead: { accountId: account.id } }
    },
    orderBy: { timestamp: 'desc' },
    select: {
      conversationId: true,
      timestamp: true,
      conversation: {
        select: {
          id: true,
          scheduledCallAt: true,
          aiActive: true,
          lead: {
            select: { id: true, name: true, handle: true, stage: true }
          }
        }
      }
    }
  });

  // Deduplicate by convo — keep most-recent Typeform send
  const byConvo = new Map<string, (typeof typeformSends)[number]>();
  for (const m of typeformSends) {
    if (!byConvo.has(m.conversationId)) byConvo.set(m.conversationId, m);
  }

  const plan: Array<{
    convoId: string;
    leadName: string;
    handle: string;
    aiActive: boolean;
    waitH: number;
    tier: ScheduledMessageType;
    body: string;
  }> = [];

  for (const row of Array.from(byConvo.values())) {
    const c = row.conversation;
    const lead = c?.lead;
    if (!c || !lead) continue;
    if (lead.stage !== 'CALL_PROPOSED') continue;
    if (c.scheduledCallAt) continue;

    // Skip if a pending follow-up already exists
    const existingPending = await prisma.scheduledMessage.findFirst({
      where: {
        conversationId: c.id,
        status: 'PENDING',
        messageType: {
          in: [
            'BOOKING_LINK_FOLLOWUP',
            'FOLLOW_UP_1',
            'FOLLOW_UP_2',
            'FOLLOW_UP_3',
            'FOLLOW_UP_SOFT_EXIT'
          ]
        }
      },
      select: { id: true }
    });
    if (existingPending) continue;

    const waitMs = Date.now() - row.timestamp.getTime();
    const tier = pickTier(waitMs);
    plan.push({
      convoId: c.id,
      leadName: lead.name ?? '<no name>',
      handle: lead.handle ?? '<no handle>',
      aiActive: c.aiActive,
      waitH: waitMs / (60 * 60 * 1000),
      tier,
      body: BOOKING_FOLLOW_UP_BODIES[tier]
    });
  }

  const willSchedule = plan.filter((p) => p.aiActive);
  const skipPaused = plan.filter((p) => !p.aiActive);

  console.log(
    `Plan: ${willSchedule.length} schedule, ${skipPaused.length} skip (AI paused)\n`
  );
  console.log('=== WILL SCHEDULE ===');
  for (const p of willSchedule) {
    console.log(
      `  ${p.leadName.padEnd(25)} convo=${p.convoId.slice(-10)} wait=${p.waitH.toFixed(1)}h  tier=${p.tier}`
    );
    console.log(`    body: ${p.body}`);
  }
  console.log('\n=== SKIP (AI paused — will fire on /toggle-ai) ===');
  for (const p of skipPaused) {
    console.log(
      `  ${p.leadName.padEnd(25)} convo=${p.convoId.slice(-10)} wait=${p.waitH.toFixed(1)}h`
    );
  }

  if (DRY) {
    console.log('\n(Dry run — no rows inserted. Set DRY=0 to execute.)');
    await prisma.$disconnect();
    return;
  }

  // Live path
  const scheduledFor = new Date(Date.now() + FIRE_DELAY_MS);
  let inserted = 0;
  for (const p of willSchedule) {
    try {
      await prisma.scheduledMessage.create({
        data: {
          conversationId: p.convoId,
          accountId: account.id,
          scheduledFor,
          messageType: p.tier,
          messageBody: p.body,
          generateAtSendTime: false,
          createdBy: 'AI'
        }
      });
      inserted++;
      console.log(
        `  ✓ ${p.leadName}: ${p.tier} at ${scheduledFor.toISOString()}`
      );
    } catch (err) {
      console.error(
        `  ✗ ${p.leadName}: failed —`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.log(`\nInserted ${inserted}/${willSchedule.length} rows.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
