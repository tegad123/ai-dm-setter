/* eslint-disable no-console */
// Find the George conversation that closed a sale + the
// [COURSE PAYMENT LINK] message, then trace which path it shipped
// through (AI generation + retry, suggestion-send, manual operator,
// scheduled message).

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  // Find AI messages containing the placeholder leak
  const leaks = await prisma.message.findMany({
    where: {
      sender: 'AI',
      content: { contains: 'COURSE PAYMENT LINK' }
    },
    orderBy: { timestamp: 'desc' },
    take: 10,
    include: {
      conversation: {
        select: {
          id: true,
          lead: { select: { name: true, handle: true, accountId: true } }
        }
      }
    }
  });

  if (leaks.length === 0) {
    // Try other variants
    const others = await prisma.message.findMany({
      where: {
        sender: 'AI',
        OR: [
          { content: { contains: 'COURSE LINK' } },
          { content: { contains: 'PAYMENT LINK' } },
          { content: { contains: 'WHOP LINK' } },
          { content: { contains: 'CHECKOUT LINK' } }
        ]
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
      include: {
        conversation: {
          select: {
            id: true,
            lead: { select: { name: true, handle: true, accountId: true } }
          }
        }
      }
    });
    console.log(
      `No "[COURSE PAYMENT LINK]" found. Other placeholder variants in AI msgs: ${others.length}\n`
    );
    for (const m of others) {
      console.log(
        `${m.timestamp.toISOString()} ${m.conversation.lead.name} → "${m.content.slice(0, 200).replace(/\n/g, ' ')}"`
      );
    }
  } else {
    console.log(
      `Found ${leaks.length} AI msgs containing "[COURSE PAYMENT LINK]":\n`
    );
    for (const m of leaks) {
      console.log(
        `${m.timestamp.toISOString()} ${m.conversation.lead.name} (@${m.conversation.lead.handle}) ` +
          `convId=${m.conversation.id}`
      );
      console.log(`  → "${m.content.replace(/\n/g, ' ')}"`);
      console.log(`  pmid=${m.platformMessageId ?? '—'}`);
    }
  }

  // Find the George conversation (probably platform=INSTAGRAM)
  console.log('\n── Searching for George conversations ──');
  const georges = await prisma.lead.findMany({
    where: {
      OR: [
        { name: { contains: 'george', mode: 'insensitive' } },
        { handle: { contains: 'george', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        select: {
          id: true,
          aiActive: true,
          outcome: true,
          messages: {
            where: {
              OR: [
                { content: { contains: '[COURSE' } },
                { content: { contains: '[PAYMENT' } },
                { content: { contains: '[WHOP' } },
                { content: { contains: '[CHECKOUT' } },
                { content: { contains: 'COURSE PAYMENT' } }
              ]
            },
            select: {
              id: true,
              sender: true,
              timestamp: true,
              content: true,
              platformMessageId: true,
              suggestionId: true,
              isHumanOverride: true,
              humanSource: true
            }
          }
        }
      }
    },
    take: 10
  });
  for (const lead of georges) {
    if (!lead.conversation) continue;
    if (lead.conversation.messages.length === 0) continue;
    console.log(
      `\nLead: ${lead.name} (@${lead.handle}) ${lead.platform} stage=${lead.stage}`
    );
    console.log(`Conversation: ${lead.conversation.id}`);
    for (const m of lead.conversation.messages) {
      console.log(
        `  ${m.timestamp.toISOString()} ${m.sender} sugId=${m.suggestionId ?? '—'} ` +
          `humanOverride=${m.isHumanOverride} humanSource=${m.humanSource ?? '—'} ` +
          `pmid=${m.platformMessageId ?? '—'}`
      );
      console.log(`    "${m.content.replace(/\n/g, ' ')}"`);
    }

    // Pull AISuggestions around those timestamps
    const ts = lead.conversation.messages[0]?.timestamp;
    if (ts) {
      const sugs = await prisma.aISuggestion.findMany({
        where: {
          conversationId: lead.conversation.id,
          generatedAt: {
            gte: new Date(ts.getTime() - 30 * 60 * 1000),
            lte: new Date(ts.getTime() + 30 * 60 * 1000)
          }
        },
        orderBy: { generatedAt: 'asc' },
        select: {
          id: true,
          generatedAt: true,
          responseText: true,
          qualityGateScore: true,
          qualityGateAttempts: true,
          qualityGatePassedFirstAttempt: true,
          wasSelected: true,
          wasRejected: true,
          wasEdited: true,
          editedByHuman: true,
          humanEditedContent: true
        }
      });
      console.log(`\n  AISuggestions in ±30min of leak (${sugs.length}):`);
      for (const s of sugs) {
        console.log(
          `    ${s.generatedAt.toISOString()} q=${(s.qualityGateScore ?? 0).toFixed(2)} ` +
            `attempts=${s.qualityGateAttempts ?? '—'} passed1st=${s.qualityGatePassedFirstAttempt} ` +
            `selected=${s.wasSelected} edited=${s.wasEdited} `
        );
        console.log(
          `      response: "${(s.responseText ?? '').slice(0, 150).replace(/\n/g, ' ')}"`
        );
        if (s.humanEditedContent) {
          console.log(
            `      humanEdit: "${s.humanEditedContent.slice(0, 150).replace(/\n/g, ' ')}"`
          );
        }
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
