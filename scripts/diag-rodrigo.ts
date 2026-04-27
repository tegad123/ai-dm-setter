/* eslint-disable no-console */
// Rodrigo Moran loop bug — pull the conversation + AISuggestion rows
// around the AI re-ask events.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'moran', mode: 'insensitive' } },
        { handle: { contains: 'moran', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { timestamp: 'asc' } }
        }
      }
    }
  });

  if (!lead || !lead.conversation) {
    console.error('No Rodrigo lead found.');
    process.exit(1);
  }

  console.log(
    `Lead: ${lead.name} (@${lead.handle}) ${lead.platform} stage=${lead.stage}`
  );
  console.log(
    `Conversation: ${lead.conversation.id} aiActive=${lead.conversation.aiActive} outcome=${lead.conversation.outcome}`
  );
  console.log(`Total messages: ${lead.conversation.messages.length}\n`);

  console.log(`── Full message log ──`);
  for (const m of lead.conversation.messages) {
    console.log(
      `${m.timestamp.toISOString()} ${m.sender.padEnd(6)} ` +
        `humanSource=${(m.humanSource ?? '—').padEnd(10)} ` +
        `"${m.content.slice(0, 110).replace(/\n/g, ' ')}"`
    );
  }

  // AISuggestion rows for this conversation (mostly relevant near the
  // alleged repeat moments).
  const sugs = await prisma.aISuggestion.findMany({
    where: { conversationId: lead.conversation.id },
    orderBy: { generatedAt: 'asc' },
    select: {
      id: true,
      generatedAt: true,
      responseText: true,
      qualityGateScore: true,
      messageBubbles: true,
      modelUsed: true,
      wasSelected: true,
      wasRejected: true,
      finalSentText: true,
      similarityToFinalSent: true
    }
  });
  console.log(`\n── ${sugs.length} AISuggestion rows ──`);
  for (const s of sugs) {
    const preview = (s.responseText || '').slice(0, 100).replace(/\n/g, ' ');
    console.log(
      `${s.generatedAt.toISOString()} q=${(s.qualityGateScore ?? 0).toFixed(2)} ` +
        `model=${(s.modelUsed ?? '—').padEnd(20)} ` +
        `selected=${s.wasSelected} rejected=${s.wasRejected} ` +
        `"${preview}"`
    );
  }

  // Capital-question detector — find AI messages whose content matches
  // the patterns checkR24Verification looks for (informally).
  console.log('\n── AI messages that look like capital questions ──');
  const capitalPatterns = [
    /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
    /\bwhat'?s your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bset aside\b.*\b(for|toward|markets?|trading)/i,
    /\b(\$|£)\s?\d+[k,]/i,
    /\bcapital ready\b/i,
    /\bjust to confirm.*\$/i,
    /\bdo you have at least \$\d/i,
    /\bdo you got at least \$\d/i,
    /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i
  ];
  let capQAsks = 0;
  for (const m of lead.conversation.messages) {
    if (m.sender !== 'AI') continue;
    if (capitalPatterns.some((p) => p.test(m.content))) {
      capQAsks++;
      console.log(
        `${m.timestamp.toISOString()} #${capQAsks} → "${m.content.slice(0, 120).replace(/\n/g, ' ')}"`
      );
    }
  }
  console.log(`\nTotal capital-question-shaped AI msgs: ${capQAsks}`);

  // Job + duration question detector
  console.log('\n── AI messages re-asking job / duration ──');
  const jobPatterns = [
    /\bwhat (do |are )?you (do|doing) for (work|a living)\b/i,
    /\bwhat'?s your (job|work|day job|career|profession)\b/i,
    /\bhow long (have|you been|you doing)\b/i
  ];
  let jobAsks = 0;
  for (const m of lead.conversation.messages) {
    if (m.sender !== 'AI') continue;
    if (jobPatterns.some((p) => p.test(m.content))) {
      jobAsks++;
      console.log(
        `${m.timestamp.toISOString()} job-shape #${jobAsks} → "${m.content.slice(0, 120).replace(/\n/g, ' ')}"`
      );
    }
  }
  console.log(`Total job-question-shaped AI msgs: ${jobAsks}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
