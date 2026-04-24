/**
 * Diagnose leads stuck in booking limbo on daetradez:
 *   - AI shipped the Typeform URL at some point in the last 7 days
 *   - lead.stage is still CALL_PROPOSED (not BOOKED) — LeadStage enum
 *     doesn't include CALL_PENDING_VERIFICATION; CALL_PROPOSED is the
 *     closest equivalent for "link sent, booking unconfirmed"
 *   - conversation.scheduledCallAt is null
 *   - last LEAD message is more than 30 minutes old
 *
 * For each such conversation, report: lead name, when the Typeform
 * URL went out, when the last LEAD reply was, and the state of every
 * ScheduledMessage row on that conversation (type, status, scheduled
 * time). Also report summary counts for the FOLLOW_UP_ cascade.
 *
 * Run: npx tsx scripts/diag-booking-limbo.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';

const TYPEFORM_URL = 'https://form.typeform.com/to/AGUtPdmb';
const LOOKBACK_DAYS = 7;
const STALE_LEAD_REPLY_MIN = 30;

function hoursSince(d: Date | null): number | null {
  if (!d) return null;
  return (Date.now() - d.getTime()) / (60 * 60 * 1000);
}

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  if (!account) {
    console.error('daetradez not found');
    process.exit(1);
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // 1. AI messages on this account in the last 7 days containing the
  // Typeform URL. The AI mostly sends this exact URL verbatim (per
  // ScriptActions + follow-up-sequence.ts TYPEFORM_BOOKING_URL).
  const typeformSends = await prisma.message.findMany({
    where: {
      sender: 'AI',
      timestamp: { gte: since },
      content: { contains: TYPEFORM_URL },
      conversation: { lead: { accountId: account.id } }
    },
    orderBy: { timestamp: 'desc' },
    select: {
      id: true,
      conversationId: true,
      content: true,
      timestamp: true,
      conversation: {
        select: {
          id: true,
          scheduledCallAt: true,
          aiActive: true,
          outcome: true,
          lastMessageAt: true,
          lead: {
            select: {
              id: true,
              name: true,
              handle: true,
              stage: true,
              platform: true
            }
          }
        }
      }
    }
  });

  console.log(
    `Daetradez Typeform sends in the last ${LOOKBACK_DAYS} days: ${typeformSends.length}`
  );

  // Deduplicate by conversation (keep the most-recent Typeform send).
  const byConvo = new Map<string, (typeof typeformSends)[number]>();
  for (const m of typeformSends) {
    if (!byConvo.has(m.conversationId)) byConvo.set(m.conversationId, m);
  }
  console.log(`Unique conversations with a Typeform URL: ${byConvo.size}\n`);

  const stuck: Array<{
    leadName: string;
    handle: string;
    stage: string;
    typeformSentAt: Date;
    lastLeadReplyAt: Date | null;
    hoursSinceTypeform: number;
    hoursSinceLastLeadReply: number | null;
    scheduledCallAt: Date | null;
    conversationId: string;
    aiActive: boolean;
    scheduledMessages: Array<{
      type: string;
      status: string;
      scheduledFor: Date;
      firedAt: Date | null;
    }>;
  }> = [];

  for (const entry of Array.from(byConvo.entries())) {
    const [conversationId, row] = entry;
    const lead = row.conversation.lead;
    if (!lead) continue;

    // Booking limbo conditions
    const notBookedStage = lead.stage === 'CALL_PROPOSED';
    const noScheduledCall = row.conversation.scheduledCallAt === null;
    if (!notBookedStage || !noScheduledCall) continue;

    // Last lead reply more than 30 minutes ago
    const lastLead = await prisma.message.findFirst({
      where: { conversationId, sender: 'LEAD' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    });
    const lastLeadReplyAt = lastLead?.timestamp ?? null;
    const leadMsgAgeMin = lastLeadReplyAt
      ? (Date.now() - lastLeadReplyAt.getTime()) / 60000
      : Infinity;
    if (leadMsgAgeMin < STALE_LEAD_REPLY_MIN) continue;

    const scheduledMessages = await prisma.scheduledMessage.findMany({
      where: { conversationId },
      orderBy: { scheduledFor: 'asc' },
      select: {
        messageType: true,
        status: true,
        scheduledFor: true,
        firedAt: true
      }
    });

    stuck.push({
      leadName: lead.name ?? '<no name>',
      handle: lead.handle ?? '<no handle>',
      stage: lead.stage,
      typeformSentAt: row.timestamp,
      lastLeadReplyAt,
      hoursSinceTypeform:
        (Date.now() - row.timestamp.getTime()) / (60 * 60 * 1000),
      hoursSinceLastLeadReply: hoursSince(lastLeadReplyAt),
      scheduledCallAt: row.conversation.scheduledCallAt,
      conversationId,
      aiActive: row.conversation.aiActive,
      scheduledMessages: scheduledMessages.map((sm) => ({
        type: sm.messageType as string,
        status: sm.status as string,
        scheduledFor: sm.scheduledFor,
        firedAt: sm.firedAt
      }))
    });
  }

  console.log(
    `=== STUCK IN BOOKING LIMBO: ${stuck.length} lead${stuck.length === 1 ? '' : 's'} ===`
  );
  for (const s of stuck) {
    console.log(
      `\n--- ${s.leadName} (@${s.handle}) ${s.aiActive ? '' : '[AI paused]'} ---`
    );
    console.log(
      `  stage=${s.stage}  convo=${s.conversationId.slice(-10)}  scheduledCallAt=${s.scheduledCallAt ? s.scheduledCallAt.toISOString() : 'null'}`
    );
    console.log(
      `  typeform sent:        ${s.typeformSentAt.toISOString()}  (${s.hoursSinceTypeform.toFixed(1)}h ago)`
    );
    console.log(
      `  last lead reply:      ${s.lastLeadReplyAt ? s.lastLeadReplyAt.toISOString() : '<never>'}  (${s.hoursSinceLastLeadReply !== null ? s.hoursSinceLastLeadReply.toFixed(1) + 'h ago' : 'n/a'})`
    );
    if (s.scheduledMessages.length === 0) {
      console.log(
        `  scheduledMessages: <none>  ⚠ no follow-up scheduled at all`
      );
    } else {
      console.log(`  scheduledMessages (${s.scheduledMessages.length}):`);
      for (const sm of s.scheduledMessages) {
        console.log(
          `    ${sm.type.padEnd(22)}  ${sm.status.padEnd(10)}  scheduledFor=${sm.scheduledFor.toISOString()}  firedAt=${sm.firedAt ? sm.firedAt.toISOString() : '-'}`
        );
      }
    }
  }

  // Aggregate counts across the bucket
  const typeCounts: Record<string, Record<string, number>> = {};
  for (const s of stuck) {
    for (const sm of s.scheduledMessages) {
      typeCounts[sm.type] ??= {};
      typeCounts[sm.type][sm.status] =
        (typeCounts[sm.type][sm.status] ?? 0) + 1;
    }
  }
  console.log('\n=== ScheduledMessage type × status (stuck leads only) ===');
  for (const [type, byStatus] of Object.entries(typeCounts).sort()) {
    const parts = Object.entries(byStatus)
      .map(([s, n]) => `${s}=${n}`)
      .join(', ');
    console.log(`  ${type.padEnd(22)}  ${parts}`);
  }
  const noFollowup = stuck.filter(
    (s) =>
      !s.scheduledMessages.some(
        (sm) =>
          [
            'BOOKING_LINK_FOLLOWUP',
            'FOLLOW_UP_1',
            'FOLLOW_UP_2',
            'FOLLOW_UP_3'
          ].includes(sm.type) && sm.status === 'PENDING'
      )
  );
  console.log(
    `\nStuck leads with NO pending follow-up: ${noFollowup.length}/${stuck.length}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
