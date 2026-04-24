/**
 * Reproduce parseLeadCapitalAnswer on Selorm Benjamin Workey's capital
 * answer to confirm whether the current parser classifies it as
 * disqualifier / hedging / ambiguous, and audit the full capitalOutcome
 * mapping to show what stage this would route to. Also pulls Selorm's
 * current DB state so we see the stage + conversation outcome at the
 * time of the audit.
 *
 * Run: npx tsx scripts/diag-selorm-capital.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { parseLeadCapitalAnswer } from '../src/lib/ai-engine';

const LEAD_ANSWER =
  "Honestly, I've lost so much in this few days and I will need sometime to raise that fund bro";

async function main() {
  console.log("=== parseLeadCapitalAnswer on Selorm's answer ===");
  console.log(`input:  ${JSON.stringify(LEAD_ANSWER)}`);
  const result = parseLeadCapitalAnswer(LEAD_ANSWER);
  console.log(`output: ${JSON.stringify(result, null, 2)}`);

  // Variant re-classifications to confirm fix direction
  const variants = [
    "Honestly, I've lost so much in this few days and I will need sometime to raise that fund bro",
    'need time to raise that fund',
    'i will need to save up',
    'working on raising it',
    "don't have it right now but i'll get there",
    'i lost so much this week'
  ];
  console.log('\n=== Variant re-classifications ===');
  for (const v of variants) {
    const r = parseLeadCapitalAnswer(v);
    console.log(
      `  ${JSON.stringify(v).padEnd(70)} → kind=${r.kind} amount=${r.amount ?? '-'} reason=${r.reason ?? '-'}`
    );
  }

  // ── Find Selorm ──
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        {
          name: {
            contains: 'Selorm',
            mode: 'insensitive'
          }
        },
        { name: { contains: 'Workey', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      accountId: true,
      name: true,
      handle: true,
      stage: true,
      previousStage: true,
      stageEnteredAt: true,
      triggerType: true,
      conversation: {
        select: {
          id: true,
          outcome: true,
          aiActive: true,
          lastMessageAt: true
        }
      }
    }
  });
  console.log('\n=== Selorm lead DB state ===');
  console.log(JSON.stringify(lead, null, 2));
  if (!lead) {
    console.log('No matching lead found.');
    await prisma.$disconnect();
    return;
  }

  // Recent AI messages for context — what did the AI actually send in
  // response to the capital answer?
  if (lead.conversation) {
    const recent = await prisma.message.findMany({
      where: { conversationId: lead.conversation.id },
      orderBy: { timestamp: 'desc' },
      take: 12,
      select: {
        sender: true,
        content: true,
        timestamp: true,
        stage: true
      }
    });
    console.log('\n=== Last 12 messages (most-recent first) ===');
    for (const m of recent) {
      console.log(
        `  ${m.timestamp.toISOString()}  ${m.sender.padEnd(5)} stage=${m.stage ?? '-'}  ${m.content.slice(0, 200).replace(/\n/g, ' ')}`
      );
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
