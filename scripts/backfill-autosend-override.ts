/**
 * Backfill: set autoSendOverride=true on every conversation where
 * aiActive=true. Also re-triggers AI generation for conversations
 * that ended on a LEAD message (lead waiting for a reply).
 *
 * Why: ai-toggle route was updated to wire autoSendOverride alongside
 * aiActive, but conversations created BEFORE that fix have aiActive=true
 * (schema default) with autoSendOverride=false. The send-policy gate
 * (aiActive && (awayMode || autoSendOverride)) returns false → AI
 * generates suggestions but never delivers them.
 *
 * Usage:
 *   DRY_RUN=true  pnpm exec tsx scripts/backfill-autosend-override.ts
 *   DRY_RUN=false pnpm exec tsx scripts/backfill-autosend-override.ts
 */

import prisma from '@/lib/prisma';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RETRIGGER = process.env.RETRIGGER !== 'false';

async function main() {
  console.log(
    `\n=== Backfill autoSendOverride (DRY_RUN=${DRY_RUN}, RETRIGGER=${RETRIGGER}) ===\n`
  );

  // 1. Find conversations needing the override flag set
  const stuck = await prisma.conversation.findMany({
    where: { aiActive: true, autoSendOverride: false },
    select: {
      id: true,
      leadId: true,
      lead: { select: { handle: true, accountId: true } },
      lastMessageAt: true
    }
  });

  console.log(
    `Found ${stuck.length} conversations needing autoSendOverride=true.\n`
  );

  if (stuck.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // 2. Apply the backfill
  if (!DRY_RUN) {
    const result = await prisma.conversation.updateMany({
      where: { aiActive: true, autoSendOverride: false },
      data: { autoSendOverride: true }
    });
    console.log(`Updated ${result.count} conversations.\n`);
  } else {
    console.log(`(DRY RUN — no writes)\n`);
    for (const c of stuck.slice(0, 20)) {
      console.log(
        `  WOULD set autoSendOverride=true: ${c.id} (@${c.lead.handle})`
      );
    }
    if (stuck.length > 20) console.log(`  ... and ${stuck.length - 20} more`);
  }

  // 3. Re-trigger AI for conversations awaiting a reply (last message was LEAD)
  if (RETRIGGER && !DRY_RUN) {
    let retriggered = 0;
    for (const c of stuck) {
      const lastMsg = await prisma.message.findFirst({
        where: { conversationId: c.id },
        orderBy: { timestamp: 'desc' },
        select: { sender: true }
      });
      if (lastMsg?.sender !== 'LEAD') continue;
      try {
        const { scheduleAIReply } = await import('@/lib/webhook-processor');
        await scheduleAIReply(c.id, c.lead.accountId);
        retriggered++;
        console.log(`  RETRIGGERED AI for @${c.lead.handle} (${c.id})`);
      } catch (err) {
        console.error(
          `  ERROR retriggering @${c.lead.handle}:`,
          (err as Error).message
        );
      }
    }
    console.log(
      `\nRe-triggered AI on ${retriggered} conversations awaiting reply.`
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
