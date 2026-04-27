/* eslint-disable no-console */
// Smoke test: run extractEstablishedFacts + countCapitalQuestionAsks
// against Rodrigo Moran's actual conversation in the DB.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import {
  extractEstablishedFacts,
  buildEstablishedFactsBlock,
  countCapitalQuestionAsks
} from '../src/lib/conversation-facts';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: { name: { contains: 'moran', mode: 'insensitive' } },
    include: {
      conversation: {
        include: { messages: { orderBy: { timestamp: 'asc' } } }
      }
    }
  });
  if (!lead?.conversation) {
    console.error('No Rodrigo lead.');
    process.exit(1);
  }

  const leadMsgs = lead.conversation.messages.filter(
    (m) => m.sender === 'LEAD'
  );
  const aiMsgs = lead.conversation.messages.filter((m) => m.sender === 'AI');

  console.log(
    `Rodrigo conversation: ${lead.conversation.messages.length} total`
  );
  console.log(`  LEAD msgs: ${leadMsgs.length}`);
  console.log(`  AI msgs:   ${aiMsgs.length}\n`);

  const facts = extractEstablishedFacts(leadMsgs);
  console.log('Extracted facts:');
  console.log(facts);

  const block = buildEstablishedFactsBlock(facts, lead.name);
  console.log('\nRendered block:\n');
  console.log(block);

  const capCount = countCapitalQuestionAsks(aiMsgs);
  console.log(`\nCapital-question asks in AI history: ${capCount}`);
  console.log(
    `(Voice gate would have hard-failed the ${capCount > 0 ? capCount + 1 : 'next'}-th attempt under the new cap.)`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
