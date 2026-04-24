/**
 * Diagnose Issue 3 of the 2026-04-24 audit: multi-bubble didn't fire
 * on a formatted numbered-list AI message.
 *
 * Pulls:
 *   - Account.multiBubbleEnabled + aiProvider for daetradez (and any
 *     persona-level flag too).
 *   - The AISuggestion row closest to the reported 12:40 timestamp.
 *   - Its responseText, messageBubbles, bubbleCount, modelUsed.
 *
 * Run: npx tsx scripts/diag-multibubble-daetradez.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { slug: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'daetradez', mode: 'insensitive' } }
      ]
    }
  });
  if (!account) {
    console.error('daetradez account not found');
    process.exit(1);
  }
  // Dump the Account row so we see every flag that could gate multi-
  // bubble without guessing the field name.
  console.log('=== Account ===');
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(account).filter(([k]) =>
          /bubble|multi|provider|away|suggestion|banner/i.test(k)
        )
      ),
      null,
      2
    )
  );

  const personas = await prisma.aIPersona.findMany({
    where: { accountId: account.id },
    select: {
      id: true,
      personaName: true,
      isActive: true,
      voiceNotesEnabled: true,
      promptConfig: true,
      updatedAt: true
    }
  });
  console.log('\n=== Personas ===');
  for (const p of personas) {
    const pc = p.promptConfig as Record<string, unknown> | null;
    const multi =
      pc && typeof pc === 'object' && 'multiBubbleEnabled' in pc
        ? (pc as Record<string, unknown>).multiBubbleEnabled
        : undefined;
    console.log(
      `  ${p.personaName} (${p.id}) active=${p.isActive} multiBubbleEnabled=${String(multi ?? '—')} updatedAt=${p.updatedAt.toISOString()}`
    );
  }

  // Hunt for the 12:40 AISuggestion — look at the last 24h of
  // suggestions on any daetradez conversation and filter those with
  // markdown-formatted content.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const suspects = await prisma.aISuggestion.findMany({
    where: {
      accountId: account.id,
      generatedAt: { gte: since },
      OR: [
        { responseText: { contains: '**' } },
        { responseText: { contains: '##' } }
      ]
    },
    orderBy: { generatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      conversationId: true,
      generatedAt: true,
      modelUsed: true,
      bubbleCount: true,
      messageBubbles: true,
      responseText: true,
      qualityGateAttempts: true,
      qualityGateScore: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true
    }
  });

  console.log(
    `\n=== AISuggestions with markdown markers in last 24h: ${suspects.length} ===`
  );
  for (const s of suspects) {
    console.log('\n---');
    console.log(`id=${s.id}  convo=${s.conversationId}`);
    console.log(
      `generatedAt=${s.generatedAt.toISOString()}  model=${s.modelUsed}  bubbleCount=${s.bubbleCount}`
    );
    console.log(
      `quality: attempts=${s.qualityGateAttempts} score=${s.qualityGateScore}`
    );
    console.log(
      `tokens: in=${s.inputTokens} out=${s.outputTokens} cached=${s.cacheReadTokens}`
    );
    console.log(
      `messageBubbles=${s.messageBubbles ? JSON.stringify(s.messageBubbles).slice(0, 400) : 'null'}`
    );
    console.log(`responseText (first 500): ${s.responseText.slice(0, 500)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
