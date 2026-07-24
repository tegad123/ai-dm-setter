// ---------------------------------------------------------------------------
// Reset LOCAL for a fresh DM test:
//   1. Truncate runtime data (Lead, Conversation, Message + cascaded children).
//      Persona / Script / Tag / TrainingConversation are preserved.
//   2. Set shazim's account response delay to 1-3s so AI replies inline fast
//      (prod uses 300-600s, which routes through the per-minute cron).
//
// Refuses to run unless DATABASE_URL is localhost. Never touches prod.
//
// Usage:
//   npx tsx scripts/reset-local-test.ts
// ---------------------------------------------------------------------------

import prisma from '../src/lib/prisma';

const LOCAL_AID = 'cmpa60h9c0000gs4l85idlaby'; // shazim's Workspace (local)

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('localhost')) {
    throw new Error(
      `DATABASE_URL is not localhost (${url.slice(0, 40)}...) — refusing.`
    );
  }

  const before = {
    leads: await prisma.lead.count(),
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count()
  };

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Lead", "Conversation", "Message" RESTART IDENTITY CASCADE;'
  );

  await prisma.account.update({
    where: { id: LOCAL_AID },
    data: { responseDelayMin: 1, responseDelayMax: 3 }
  });

  console.log(
    `Cleared: ${before.leads} leads, ${before.conversations} conversations, ${before.messages} messages.`
  );
  console.log('Response delay set to 1-3s for shazim (local).');
  console.log('\nReady. Fire a test:');
  console.log(
    '  ./scripts/simulate-fb-dm.sh "yo bro, whats your move for sizing?"'
  );
}

main()
  .catch((e) => {
    console.error('FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
