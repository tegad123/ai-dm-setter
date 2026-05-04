/* eslint-disable no-console */
// One-shot backfill for the 12 pending ManyChat-handoff'd leads stuck before
// the 2026-05-04 fix wired scheduleAIReply into processManyChatHandoff.
// Pre-fix conversations have a LEAD message at the top of the thread with no
// AI follow-up; many of them ALSO have aiActive=false because the account's
// awayMode toggle was off at handoff creation time. Heartbeat skips both
// states (it requires aiActive=true AND awaitingAiResponse=true).
//
// This script flips, on each affected conversation:
//   - aiActive            -> true
//   - awaitingAiResponse  -> true
//   - awaitingSince       -> last LEAD message timestamp
//   - silentStopCount     -> 0
//   - lastSilentStopAt    -> null
// The next heartbeat tick (every minute) picks them up and routes through
// the standard recovery flow.
//
// Idempotent: a second run is a no-op for any row that's already flagged
// or has since received an AI reply (latest message becomes AI/HUMAN).
//
// Run with env vars loaded:
//   set -a && source .env && set +a && npx tsx scripts/backfill-stuck-manychat-leads.ts

import prisma from '../src/lib/prisma';

const ELIGIBLE_STAGES = ['NEW_LEAD', 'ENGAGED', 'QUALIFYING'] as const;
const TARGET_CONVERSATION_IDS = [
  'cmnp9r1mh000ml304dj6dz1a3', // mr.cocoabutter
  'cmor39iib000nl504pjq9afbs', // arielbuenaflorumpacan
  'cmor3p1m9000vl504yhu3eqi2', // christiaan99__
  'cmor6mziv0003jo045wopec5h', // philip.pkfr
  'cmor839xq000bjo04304x6hxg', // _ibran_ash89
  'cmor87h59000jjo0438caynvl', // officeenrich
  'cmor8h2ed000rjo04uily0n75', // ww.w.davidl
  'cmorbifjw0003l504uja2infv', // iam.ebere
  'cmor0oirg0003l5044g75ldb2', // tegaumukoro_
  'cmorglnjw0003jy04bbnt5znb', // teerawat_prasertkun
  'cmorgve4b0003l404doiozd9c', // imarap_nickol
  'cmori4ygk0003jv04w5ucexu2' // kofiadu262
];

async function main() {
  // Narrow filter at the DB layer to the known pending conversations only.
  // The two already-replied conversations (mulu_lu.8, dominicianpappi) are
  // intentionally not in TARGET_CONVERSATION_IDS.
  const candidates = await prisma.conversation.findMany({
    where: {
      id: { in: TARGET_CONVERSATION_IDS },
      source: 'MANYCHAT',
      awaitingAiResponse: false,
      lead: { stage: { in: [...ELIGIBLE_STAGES] } }
    },
    select: {
      id: true,
      aiActive: true,
      lead: { select: { id: true, handle: true, stage: true } },
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { id: true, sender: true, timestamp: true, content: true }
      }
    }
  });

  console.log(
    `[backfill] scanned ${candidates.length}/${TARGET_CONVERSATION_IDS.length} targeted ManyChat conversation(s) with awaitingAiResponse=false and stage in {${ELIGIBLE_STAGES.join(', ')}}`
  );

  let flipped = 0;
  let alsoTurnedAiOn = 0;
  let skippedNoMessage = 0;
  let skippedLatestNotLead = 0;

  for (const conv of candidates) {
    const lastMsg = conv.messages[0];
    if (!lastMsg) {
      skippedNoMessage += 1;
      continue;
    }
    if (lastMsg.sender !== 'LEAD') {
      skippedLatestNotLead += 1;
      continue;
    }
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        aiActive: true,
        awaitingAiResponse: true,
        awaitingSince: lastMsg.timestamp,
        silentStopCount: 0,
        lastSilentStopAt: null
      }
    });
    flipped += 1;
    if (!conv.aiActive) alsoTurnedAiOn += 1;
    const handle = conv.lead?.handle ?? 'unknown';
    const aiNote = conv.aiActive ? '' : ' [aiActive=false->true]';
    console.log(
      `[backfill] flipped ${conv.id} (@${handle}, stage=${conv.lead?.stage})${aiNote} - awaitingSince=${lastMsg.timestamp.toISOString()} - last LEAD msg: "${lastMsg.content.slice(0, 80)}"`
    );
  }

  console.log('[backfill] ---------------------------------------------');
  console.log(`[backfill] candidates scanned:        ${candidates.length}`);
  console.log(`[backfill] flipped to awaiting=true:  ${flipped}`);
  console.log(`[backfill]   of which aiActive flipped: ${alsoTurnedAiOn}`);
  console.log(`[backfill] skipped (no messages):     ${skippedNoMessage}`);
  console.log(`[backfill] skipped (latest != LEAD):  ${skippedLatestNotLead}`);
  console.log('[backfill] ---------------------------------------------');
  console.log(
    `[backfill] done. Heartbeat (cron every 1m) will pick up the ${flipped} flipped conversation(s) on the next tick.`
  );
}

main()
  .catch((err) => {
    console.error('[backfill] FATAL:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
