/**
 * One-off: manually flag Cristian Caciora's conversation with the
 * schedulingConflict signal the parser missed, so the dashboard shows
 * the URGENT row and the operator email fires right now.
 *
 * Sets:
 *   Conversation.schedulingConflict = true
 *   Conversation.schedulingConflictAt = now
 *   Conversation.schedulingConflictPreference =
 *     "Sunday (Romania timezone, EET/UTC+2), phone call"
 *
 * Then invokes escalate() to write the Notification row and send the
 * email via Resend if RESEND_API_KEY + Account.notificationEmail are
 * configured.
 *
 * Run: npx tsx scripts/escalate-cristian.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { escalate } from '../src/lib/escalation-dispatch';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { name: { contains: 'Cristian Caciora', mode: 'insensitive' } },
    select: {
      id: true,
      accountId: true,
      name: true,
      handle: true,
      conversation: {
        select: {
          id: true,
          schedulingConflict: true,
          schedulingConflictPreference: true
        }
      }
    }
  });
  if (!lead?.conversation) {
    console.error('Cristian not found or missing conversation');
    process.exit(1);
  }
  console.log(
    `Found: ${lead.name} (${lead.id}) convo=${lead.conversation.id}, schedulingConflict=${lead.conversation.schedulingConflict}`
  );

  const preference = 'Sunday (Romania timezone, EET/UTC+2), wants phone call';
  if (!lead.conversation.schedulingConflict) {
    await prisma.conversation.update({
      where: { id: lead.conversation.id },
      data: {
        schedulingConflict: true,
        schedulingConflictAt: new Date(),
        schedulingConflictPreference: preference
      }
    });
    console.log('✓ Conversation flagged schedulingConflict=true');
  } else {
    console.log('(Already flagged — refreshing preference text.)');
    await prisma.conversation.update({
      where: { id: lead.conversation.id },
      data: { schedulingConflictPreference: preference }
    });
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://qualifydms.io';
  const link = `${origin.replace(/\/$/, '')}/dashboard/conversations/${lead.conversation.id}`;
  const res = await escalate({
    type: 'scheduling_conflict',
    accountId: lead.accountId,
    leadId: lead.id,
    conversationId: lead.conversation.id,
    leadName: lead.name,
    leadHandle: lead.handle,
    title: `Lead needs manual scheduling — ${lead.name}`,
    body: `${lead.name} (@${lead.handle}) filled out the application but can't make the offered times.\n\nThey're available: ${preference}.\n\nReach out to confirm a Sunday time that works for both sides.`,
    details: `Available: ${preference}`,
    link
  });
  console.log(
    `Escalation dispatched: notificationId=${res.notificationId} emailOk=${res.emailOk} emailError=${res.emailError ?? '-'} tier=${res.tier} channels=${res.channels.join('+')}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
