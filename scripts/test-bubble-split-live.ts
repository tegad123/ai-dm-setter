/**
 * Live test of the strengthened multi-bubble prompt on daetradez. Uses
 * the actual production `generateReply` path on a disposable lead tied
 * to the real daetradez account (same persona, same multiBubbleEnabled
 * flag, same stored OpenAI credential → gpt-5.4-mini).
 *
 * Sends the test message from the diagnostic spec:
 *   "I've been trading for 2 years, made some gains but lost them all.
 *    I want to replace my income through trading and I have about
 *    $2,000 set aside. What would you recommend?"
 *
 * After generation, dumps the raw result (reply + messages array) AND
 * the persisted AISuggestion so we can see what the LLM produced vs
 * what got stored.
 *
 * Run: npx tsx scripts/test-bubble-split-live.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { generateReply } from '../src/lib/ai-engine';
import type { LeadContext } from '../src/lib/ai-prompts';

const TEST_MSG =
  "I've been trading for 2 years, made some gains but lost them all. I want to replace my income through trading and I have about $2,000 set aside. What would you recommend?";

async function main() {
  const daetradez = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  if (!daetradez) {
    console.error('daetradez not found');
    process.exit(1);
  }

  const suffix = `bubble-test-${Date.now()}`;
  const lead = await prisma.lead.create({
    data: {
      accountId: daetradez.id,
      name: `BubbleTest ${suffix}`,
      handle: `bubble_${suffix}`,
      platform: 'FACEBOOK',
      platformUserId: `psid_${suffix}`,
      triggerType: 'DM',
      stage: 'QUALIFYING'
    }
  });
  const convo = await prisma.conversation.create({
    data: { leadId: lead.id, aiActive: true }
  });
  const leadMsg = await prisma.message.create({
    data: {
      conversationId: convo.id,
      sender: 'LEAD',
      content: TEST_MSG,
      timestamp: new Date()
    }
  });

  try {
    const history = [
      {
        id: leadMsg.id,
        role: 'user' as const,
        content: leadMsg.content,
        sender: 'LEAD' as const,
        timestamp: leadMsg.timestamp.toISOString()
      }
    ];
    const leadCtx: LeadContext = {
      leadName: `BubbleTest ${suffix}`,
      handle: `bubble_${suffix}`,
      platform: 'FACEBOOK',
      status: 'QUALIFYING',
      triggerType: 'DM',
      triggerSource: null,
      qualityScore: 0,
      tags: [],
      source: undefined,
      experience: undefined,
      incomeLevel: undefined,
      geography: undefined,
      timezone: undefined
    };

    console.log('=== Calling generateReply on daetradez with test message ===');
    console.log(`lead msg: ${TEST_MSG}\n`);

    const result = await generateReply(
      daetradez.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      history as any,
      leadCtx
    );

    console.log('--- RESULT ---');
    console.log(`reply: ${result.reply}`);
    console.log(`messages count: ${result.messages?.length ?? 0}`);
    if (result.messages && result.messages.length > 0) {
      result.messages.forEach((m, i) => {
        console.log(`  [${i}] (${m.length} chars) ${m}`);
      });
    }
    console.log(`stage=${result.stage}  subStage=${result.subStage}`);

    // Also fetch the persisted AISuggestion
    const suggestion = await prisma.aISuggestion.findFirst({
      where: { conversationId: convo.id },
      orderBy: { generatedAt: 'desc' }
    });
    if (suggestion) {
      console.log('\n--- AISuggestion row ---');
      console.log(`id=${suggestion.id}`);
      console.log(`model=${suggestion.modelUsed}`);
      console.log(`bubbleCount=${suggestion.bubbleCount}`);
      console.log(
        `messageBubbles=${suggestion.messageBubbles ? JSON.stringify(suggestion.messageBubbles) : 'null'}`
      );
      console.log(
        `qualityGateScore=${suggestion.qualityGateScore}  attempts=${suggestion.qualityGateAttempts}`
      );
      console.log(
        `tokens: in=${suggestion.inputTokens} out=${suggestion.outputTokens} cachedRead=${suggestion.cacheReadTokens}`
      );
    }
  } finally {
    // Clean up: delete test resources so this doesn't pollute the real
    // daetradez dashboard.
    await prisma.aISuggestion
      .deleteMany({ where: { conversationId: convo.id } })
      .catch(() => {});
    await prisma.message
      .deleteMany({ where: { conversationId: convo.id } })
      .catch(() => {});
    await prisma.conversation
      .delete({ where: { id: convo.id } })
      .catch(() => {});
    await prisma.leadStageTransition
      .deleteMany({ where: { leadId: lead.id } })
      .catch(() => {});
    await prisma.inboundQualification
      .deleteMany({ where: { leadId: lead.id } })
      .catch(() => {});
    await prisma.lead.delete({ where: { id: lead.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('TEST FAILED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
