/**
 * Retrigger AI replies for conversations where the lead is waiting
 * (last message sender = LEAD, AI is active, autoSendOverride is on).
 *
 * Used after fixing config issues (token re-auth, account ID corruption,
 * etc.) to push AI replies that should have fired but didn't.
 *
 * Usage:
 *   DRY_RUN=true  pnpm exec tsx scripts/retrigger-stuck-ai-replies.ts
 *   DRY_RUN=false pnpm exec tsx scripts/retrigger-stuck-ai-replies.ts
 */

import prisma from '@/lib/prisma';
import { scheduleAIReply } from '@/lib/webhook-processor';

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  console.log(`\n=== Retrigger stuck AI replies (DRY_RUN=${DRY_RUN}) ===\n`);

  // Find candidate conversations: AI active, override on, has at least one message
  const candidates = await prisma.conversation.findMany({
    where: { aiActive: true, autoSendOverride: true },
    select: {
      id: true,
      leadId: true,
      lastMessageAt: true,
      lead: { select: { handle: true, accountId: true, platformUserId: true } }
    },
    orderBy: { lastMessageAt: 'desc' }
  });

  let triggered = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Get the last message — must be LEAD-side for AI to owe a response
    const lastMsg = await prisma.message.findFirst({
      where: { conversationId: c.id },
      orderBy: { timestamp: 'desc' },
      select: { sender: true, timestamp: true }
    });
    if (!lastMsg || lastMsg.sender !== 'LEAD') {
      skipped++;
      continue;
    }

    // Skip if platformUserId isn't a numeric IG ID — AI can't deliver
    if (!c.lead.platformUserId || !/^\d{12,}$/.test(c.lead.platformUserId)) {
      console.log(
        `  SKIP @${c.lead.handle}: platformUserId="${c.lead.platformUserId}" not numeric — waiting for IG webhook upgrade`
      );
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  WOULD trigger AI for @${c.lead.handle} (last lead msg ${lastMsg.timestamp.toISOString()})`
      );
      triggered++;
      continue;
    }

    try {
      await scheduleAIReply(c.id, c.lead.accountId);
      triggered++;
      console.log(`  TRIGGERED @${c.lead.handle} (${c.id})`);
    } catch (err) {
      console.error(`  ERROR @${c.lead.handle}:`, (err as Error).message);
    }
  }

  console.log(`\nTriggered: ${triggered}, skipped: ${skipped}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
